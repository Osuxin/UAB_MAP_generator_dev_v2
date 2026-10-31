import type { Barrier, GeneratedMap, Point } from "./mapGenerator";
import { TACTICAL_FIELDS, type TacticalConfig, type TacticalValues } from "./tacticalSettings";
import { clamp01, clearSegment, createNavigator, distance, firingAngle, samplePath, pointAtDistance, pathLength } from "./tacticalGeometry";

type Field = GeneratedMap["field"];
type Team = 1 | -1;
export type ShootingPosition = Point & { barrierId: string; side: "left" | "right" };
type Cover = { barrier: Barrier; hold: Point; shots: ShootingPosition[]; depth: number };
type Route = { from: string | null; to: string; path: Point[]; samples: Point[]; length: number; depth: number; initial: boolean };
type TeamPlan = { team: Team; covers: Cover[]; routes: Route[]; initial: Route[]; points: Record<string, number> };
export const MODEL = {
  bodyOffset: 0.22,
  sameDepthTolerance: 0.5,
  vCrossWidth: 1.5,
  rearDepth: 0.35,
  routeSampleSpacing: 0.25,
  retakeAngle: 60,
} as const;
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const progress = (p: Point, field: Field, team: Team) => team === 1 ? p.y / field.height : 1 - p.y / field.height;

export function shootingPositions(barrier: Barrier, team: Team, field: Field, barriers: Barrier[]): ShootingPosition[] {
  return (["left", "right"] as const).flatMap((side) => {
    const sorted = [...barrier.polygon].sort((a, b) => side === "left" ? a.x - b.x || team * (a.y - b.y) : b.x - a.x || team * (a.y - b.y));
    const vertex = sorted[0];
    const p = { x: vertex.x + (side === "left" ? -MODEL.bodyOffset : MODEL.bodyOffset), y: vertex.y, barrierId: barrier.id, side };
    return p.x >= 0.12 && p.x <= field.width - 0.12 && p.y >= 0.12 && p.y <= field.height - 0.12 && clearSegment(p, p, barriers, 0.12) ? [p] : [];
  });
}

// Points are relative to each team's opponent half. X never affects the rank.
// Barrier center and 0.5m row grouping are provisional conventions.
export function aggressivePoints(field: Field, barriers: Barrier[], team: Team): Record<string, number> {
  const result: Record<string, number> = Object.fromEntries(barriers.map(b => [b.id, 0]));
  const ordered = barriers.filter(b => progress(b, field, team) > 0.5 + 1e-9)
    .sort((a, b) => progress(a, field, team) - progress(b, field, team));
  let rowDepth = -Infinity, rank = 0;
  for (const barrier of ordered) {
    const depth = progress(barrier, field, team) * field.height;
    if (depth - rowDepth > MODEL.sameDepthTolerance + 1e-9) { rowDepth = depth; rank++; }
    result[barrier.id] = rank;
  }
  return result;
}
export function finalAggressiveScore(points: Record<string, number>, players: Array<{ alive: boolean; touchingBarrierId: string | null }>): number {
  return players.reduce((total, player) => total + (player.alive && player.touchingBarrierId ? points[player.touchingBarrierId] ?? 0 : 0), 0);
}

// Each selected position represents one player. Never combine both peeks of a cover
// as one player, and never deploy more than the specified number of players.
export function selectThreats(options: Array<{ position: ShootingPosition; mask: boolean[] }>, limit = 3) {
  const selected: typeof options = [];
  const used = new Set<string>();
  const covered = Array.from({ length: options[0]?.mask.length ?? 0 }, () => false);
  while (selected.length < limit) {
    let best: typeof options[number] | undefined, gain = 0;
    for (const option of options) {
      if (used.has(option.position.barrierId)) continue;
      const added = option.mask.filter((hit, i) => hit && !covered[i]).length;
      if (added > gain) { best = option; gain = added; }
    }
    if (!best) break;
    selected.push(best); used.add(best.position.barrierId);
    best.mask.forEach((hit, i) => { covered[i] ||= hit; });
  }
  return { selected, covered };
}

export function crossQuality(a: Point, b: Point, target: Point, team: Team, field: Field): number {
  // Both shooters must be on the own-land side of the intersection.
  if (team * (target.y - a.y) <= 0 || team * (target.y - b.y) <= 0) return 0;
  // X crossing: left shooter aims right, right shooter aims left.
  if ((a.x - target.x) * (b.x - target.x) >= 0) return 0;
  const angle = firingAngle(a, b, target);
  const angleBonus = angle >= 45 && angle <= 90 ? 1 : 0;
  const locationBonus = progress(target, field, team) > 0.5 ? 1 : 0;
  return 0.7 + 0.2 * angleBonus + 0.1 * locationBonus;
}
// The two V arms may suppress different routes; both must actually have a target.
export function vCrossCoverage(p: Point, q: Point, hits: Array<{ target: Point; p: boolean; q: boolean; weight?: number }>, team: Team): number {
  if (Math.abs(p.x - q.x) > MODEL.vCrossWidth) return 0;
  const score = (reverse: boolean) => {
    const left = hits.map(h => (reverse ? h.q : h.p) && h.target.x < (reverse ? q.x : p.x) && team * (h.target.y - (reverse ? q.y : p.y)) > 0);
    const right = hits.map(h => (reverse ? h.p : h.q) && h.target.x > (reverse ? p.x : q.x) && team * (h.target.y - (reverse ? p.y : q.y)) > 0);
    const total = hits.reduce((sum, h) => sum + (h.weight ?? 1), 0);
    return left.some(Boolean) && right.some(Boolean) && total > 0
      ? hits.reduce((sum, h, i) => sum + (left[i] || right[i] ? h.weight ?? 1 : 0), 0) / total : 0;
  };
  return Math.max(score(false), score(true));
}
export function multiDirectionQuality(a: Point, b: Point, target: Point): number {
  return clamp01((firingAngle(a, b, target) - 15) / (MODEL.retakeAngle - 15));
}

function createTeamPlan(field: Field, barriers: Barrier[], team: Team, navigate: ReturnType<typeof createNavigator>): TeamPlan {
  const start = team === 1 ? field.bottomStart : field.topStart;
  const covers: Cover[] = barriers.flatMap(barrier => {
    const vertex = [...barrier.polygon].sort((a, b) => team * (a.y - b.y))[0];
    const hold = { x: vertex.x, y: vertex.y - team * MODEL.bodyOffset };
    if (!clearSegment(hold, hold, barriers, 0.12)) return [];
    const shots = shootingPositions(barrier, team, field, barriers).filter(p => navigate(hold, p) !== null);
    return [{ barrier, hold, shots, depth: progress(barrier, field, team) }];
  });
  const makeRoute = (from: Cover | null, to: Cover): Route | null => {
    const path = navigate(from?.hold ?? start, to.hold);
    if (!path) return null;
    return { from: from?.barrier.id ?? null, to: to.barrier.id, initial: !from,
      depth: from?.depth ?? 0,
      path,
      samples: samplePath(path, MODEL.routeSampleSpacing),
      length: pathLength(path) };
  };
  const initial: Route[] = [];
  for (const side of [-1, 1]) {
    const candidates = covers.filter(c => c.depth < 0.5 && side * (c.barrier.x - field.width / 2) >= 0);
    const routes = candidates.map(c => makeRoute(null, c)).filter((r): r is Route => r !== null).sort((a, b) => a.length - b.length);
    if (routes[0] && !initial.some(r => r.to === routes[0].to)) initial.push(routes[0]);
  }
  const routes = [...initial];
  const reachable = new Set(initial.map(r => r.to));
  // Forward-only expansion guarantees that evaluated shooting positions can be reached.
  for (const from of [...covers].sort((a, b) => a.depth - b.depth)) {
    if (!reachable.has(from.barrier.id)) continue;
    const next = covers.filter(c => c.depth > from.depth + 0.02)
      .sort((a, b) => distance(from.hold, a.hold) - distance(from.hold, b.hold)).slice(0, 3);
    for (const to of next) {
      const route = makeRoute(from, to);
      if (route) { routes.push(route); reachable.add(to.barrier.id); }
    }
  }
  return { team, covers: covers.filter(c => reachable.has(c.barrier.id)), routes, initial, points: aggressivePoints(field, barriers, team) };
}

export function evaluateTactics(field: Field, barriers: Barrier[], config: TacticalConfig) {
  const navigate = createNavigator(field.width, field.height, barriers);
  const plans = [createTeamPlan(field, barriers, 1, navigate), createTeamPlan(field, barriers, -1, navigate)];
  const sightCache = new Map<string, boolean>();
  const visible = (a: Point, b: Point) => {
    const key = a.x + "," + a.y + ":" + b.x + "," + b.y;
    if (!sightCache.has(key)) sightCache.set(key, clearSegment(a, b, barriers));
    return sightCache.get(key)!;
  };
  const masks = new Map<Route, Map<ShootingPosition, boolean[]>>();
  const routeMask = (p: ShootingPosition, r: Route) => {
    if (!masks.has(r)) masks.set(r, new Map());
    const map = masks.get(r)!;
    if (!map.has(p)) map.set(p, r.samples.map(q => visible(p, q)));
    return map.get(p)!;
  };
  const teamResults = plans.map((own, index) => {
    const enemy = plans[1 - index];
    const homeShots = own.covers.filter(c => c.depth <= 0.5).flatMap(c => c.shots);
    const enemyShots = enemy.covers.filter(c => c.depth <= 0.5).flatMap(c => c.shots);
    // A moving opponent can create break lines, not only the opponent's start point.
    // Equal movement speed is assumed; compare positions at equal travelled distance.
    const breakExposures = own.initial.map(route => Math.max(0, ...enemy.initial.map(other => {
      return mean(route.samples.map((p, i) => {
        const travelled = Math.min(i * MODEL.routeSampleSpacing, route.length);
        return visible(p, pointAtDistance(other.path, travelled)) ? 1 : 0;
      }));
    })));
    const safety: number[] = [], support: number[] = [], gains: number[] = [];
    for (const route of own.routes.filter(r => !r.initial)) {
      const threat = selectThreats(enemyShots.map(position => ({ position, mask: routeMask(position, route) })), 3);
      const exposure = mean(threat.covered.map(Number));
      safety.push(1 - exposure);
      const supporters = own.covers.filter(c => c.depth <= route.depth + 0.02 && c.barrier.id !== route.from && c.barrier.id !== route.to).flatMap(c => c.shots);
      let bestSupport = 0;
      for (let a = 0; a < supporters.length; a++) for (let b = a; b < supporters.length; b++) {
        if (a !== b && supporters[a].barrierId === supporters[b].barrierId) continue;
        const remaining = threat.selected.filter(t => !visible(supporters[a], t.position) && !visible(supporters[b], t.position));
        const freed = threat.covered.filter((hit, i) => hit && !remaining.some(t => t.mask[i])).length;
        bestSupport = Math.max(bestSupport, freed / Math.max(1, threat.covered.filter(Boolean).length));
      }
      // No threat means no demonstrated need/opportunity for support, rather than free 100 points.
      support.push(exposure > 0 ? bestSupport : 0);
      const from = own.covers.find(c => c.barrier.id === route.from)!;
      const to = own.covers.find(c => c.barrier.id === route.to)!;
      const control = (cover: Cover) => Math.max(0, ...cover.shots.map(p => mean(enemy.routes.map(r => mean(r.samples.map(q => visible(p, q) ? 1 : 0))))));
      const pointGain = clamp01(((own.points[to.barrier.id] ?? 0) - (own.points[from.barrier.id] ?? 0)) / Math.max(1, ...Object.values(own.points)));
      const laneGain = clamp01((control(to) - control(from)) * 2);
      gains.push(clamp01(pointGain * 0.55 + laneGain * 0.45));
    }
    const crossAt = (forward: boolean) => {
      const candidates = own.covers.filter(c => forward ? c.depth > MODEL.rearDepth : c.depth <= MODEL.rearDepth).flatMap(c => c.shots);
      let best = 0;
      for (let a = 0; a < candidates.length; a++) for (let b = a + 1; b < candidates.length; b++) {
        const p = candidates[a], q = candidates[b];
        if (p.barrierId === q.barrierId) continue;
        const vCross = Math.abs(p.x - q.x) <= MODEL.vCrossWidth;
        const routeHits = enemy.routes.map(route => {
          const pm = routeMask(p, route), qm = routeMask(q, route);
          return { route, pm, qm };
        });
        const allTargets = routeHits.flatMap(({ route, pm, qm }) => route.samples.map((target, i) => ({ target, p: pm[i], q: qm[i], weight: 1 / route.samples.length })));
        const vCoverage = vCross ? vCrossCoverage(p, q, allTargets, own.team) : 0;
        const ordinaryCoverage = mean(routeHits.map(({ route, pm, qm }) => mean(route.samples.map((target, i) => pm[i] && qm[i] ? crossQuality(p, q, target, own.team, field) : 0))));
        // Fixed pair, fixed side per player across all routes. Two players <= three-person team.
        best = Math.max(best, ordinaryCoverage, vCoverage);
      }
      return best;
    };
    const forwardCross = crossAt(true), rearCross = crossAt(false);
    const retakes = enemy.covers.filter(c => c.depth > 0.5 && enemy.points[c.barrier.id] > 0).map(intruder => {
      const target = intruder.hold;
      const attackers = homeShots.filter(p => p.barrierId !== intruder.barrier.id && visible(p, target));
      let best = 0;
      for (let a = 0; a < attackers.length; a++) for (let b = a + 1; b < attackers.length; b++) {
        if (attackers[a].barrierId === attackers[b].barrierId) continue;
        best = Math.max(best, multiDirectionQuality(attackers[a], attackers[b], target));
      }
      return best;
    });
    const initialSafety = own.initial.length ? 1 - mean(breakExposures) : 0;
    const attackShare = 1 - config.playStyle / 100;
    const cross = forwardCross * (0.2 + 0.6 * attackShare) + rearCross * (0.8 - 0.6 * attackShare);
    return { advance: (0.75 * mean(safety) + 0.25 * initialSafety) * 100,
      support: mean(support) * 100, gain: mean(gains) * 100, retake: mean(retakes) * 100, cross: cross * 100,
      forwardCross: forwardCross * 100, rearCross: rearCross * 100,
      breakPressure: mean(breakExposures) * 100, routes: own.routes.length };
  });
  const values = Object.fromEntries(TACTICAL_FIELDS.map(({ key }) => [key, mean(teamResults.map(r => r[key]))])) as TacticalValues;
  const playable = plans.every(plan => plan.initial.length > 0 && plan.routes.some(route => !route.initial));
  // Priority 1 has the greatest influence; priority 6 has the least.
  const totalWeight = TACTICAL_FIELDS.reduce((sum, f) => sum + (7 - config[f.priorityKey]), 0);
  const score = playable && totalWeight > 0 ? Math.round(TACTICAL_FIELDS.reduce((sum, f) =>
    sum + (100 - Math.abs(values[f.key] - config[f.key])) * (7 - config[f.priorityKey]), 0) / totalWeight) : 0;
  const round = (n: number) => Math.round(n * 10) / 10;
  return { score, details: Object.fromEntries(TACTICAL_FIELDS.map(f => [f.label, round(values[f.key])])),
    diagnostics: { forwardCross: round(mean(teamResults.map(r => r.forwardCross))), rearCross: round(mean(teamResults.map(r => r.rearCross))),
      breakPressure: round(mean(teamResults.map(r => r.breakPressure))), reachableRoutes: teamResults.map(r => r.routes) },
  };
}
