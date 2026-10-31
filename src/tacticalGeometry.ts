import type { Barrier, Point } from "./mapGenerator";
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
export function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const length = distance(a, b) ** 2;
  const t = length ? clamp01(((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / length) : 0;
  return distance(p, { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
}
export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const v = [cross(a, b, c), cross(a, b, d), cross(c, d, a), cross(c, d, b)];
  if (v[0] * v[1] < 0 && v[2] * v[3] < 0) return true;
  return (Math.abs(v[0]) < 1e-9 && pointSegmentDistance(c, a, b) < 1e-9)
    || (Math.abs(v[1]) < 1e-9 && pointSegmentDistance(d, a, b) < 1e-9)
    || (Math.abs(v[2]) < 1e-9 && pointSegmentDistance(a, c, d) < 1e-9)
    || (Math.abs(v[3]) < 1e-9 && pointSegmentDistance(b, c, d) < 1e-9);
}
export function inside(p: Point, polygon: Point[]): boolean {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if (pointSegmentDistance(p, a, b) < 1e-8) return true;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}
export function clearSegment(a: Point, b: Point, barriers: Barrier[], clearance = 0): boolean {
  return barriers.every(({ polygon }) => {
    if (inside(a, polygon) || inside(b, polygon)) return false;
    return polygon.every((c, i) => {
      const d = polygon[(i + 1) % polygon.length];
      return !segmentsIntersect(a, b, c, d) && (clearance <= 0 || Math.min(
        pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d),
        pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b),
      ) >= clearance);
    });
  });
}

// The actual angle between the two shooter vectors (0..180), never the acute-angle shortcut.
export function firingAngle(a: Point, b: Point, target: Point): number {
  const length = distance(a, target) * distance(b, target);
  if (length < 1e-9) return 0;
  return Math.acos(Math.max(-1, Math.min(1, ((a.x - target.x) * (b.x - target.x) + (a.y - target.y) * (b.y - target.y)) / length))) * 180 / Math.PI;
}

export function pathLength(path: Point[]): number {
  return path.slice(1).reduce((sum, point, i) => sum + distance(path[i], point), 0);
}

// Interpolate on the original polyline, preserving detour corners.
// A player who has reached the end remains at that endpoint.
export function pointAtDistance(path: Point[], travelled: number): Point {
  if (!path.length) throw new Error("経路が空です。");
  let remaining = Math.max(0, travelled);
  for (let i = 1; i < path.length; i++) {
    const length = distance(path[i - 1], path[i]);
    if (length <= 1e-12) continue;
    if (remaining <= length) {
      const t = remaining / length;
      return { x: path[i - 1].x + (path[i].x - path[i - 1].x) * t,
        y: path[i - 1].y + (path[i].y - path[i - 1].y) * t };
    }
    remaining -= length;
  }
  return path[path.length - 1];
}

// Include start/end and every 0.25m of travelled distance. The final gap may be shorter.
export function samplePath(path: Point[], spacing = 0.25): Point[] {
  if (!Number.isFinite(spacing) || spacing <= 0) throw new Error("評価間隔は正の有限値にしてください。");
  if (!path.length) return [];
  const total = pathLength(path);
  if (total <= 1e-12) return path.slice(0, 1);
  const steps = Math.ceil(total / spacing);
  return Array.from({ length: steps + 1 }, (_, i) => pointAtDistance(path, Math.min(i * spacing, total)));
}

// Straight routes first; lazy 8-neighbor A* only when cover forces a detour.
// Every connector and grid edge is checked; diagonal corner-cutting is impossible.
export function createNavigator(width: number, height: number, barriers: Barrier[]) {
  const step = 0.5, clearance = 0.12;
  const cols = Math.floor((width - 0.3) / step) + 1;
  const rows = Math.floor((height - 0.3) / step) + 1;
  const points = Array.from({ length: cols * rows }, (_, id) => ({ x: 0.15 + (id % cols) * step, y: 0.15 + Math.floor(id / cols) * step }));
  const usable = new Map<number, boolean>();
  const edges = new Map<string, boolean>();
  const valid = (id: number) => {
    if (!usable.has(id)) usable.set(id, clearSegment(points[id], points[id], barriers, clearance));
    return usable.get(id)!;
  };
  const connect = (p: Point) => points.map((q, id) => ({ id, d: distance(p, q) }))
    .filter(({ d }) => d <= 1.2).sort((a, b) => a.d - b.d)
    .filter(({ id }) => valid(id) && clearSegment(p, points[id], barriers, clearance)).slice(0, 4);
  return (a: Point, b: Point): Point[] | null => {
    if (clearSegment(a, b, barriers, clearance)) return [a, b];
    const starts = connect(a), ends = connect(b);
    if (!starts.length || !ends.length) return null;
    const goals = new Map(ends.map(({ id, d }) => [id, d]));
    const costs = new Map(starts.map(({ id, d }) => [id, d]));
    const previous = new Map<number, number>();
    const open = new Set(starts.map(({ id }) => id));
    const closed = new Set<number>();
    while (open.size) {
      let current = -1, best = Infinity;
      for (const id of open) {
        const f = costs.get(id)! + distance(points[id], b);
        if (f < best) { best = f; current = id; }
      }
      if (goals.has(current)) {
        const path = [points[current]];
        while (previous.has(current)) { current = previous.get(current)!; path.unshift(points[current]); }
        return [a, ...path, b];
      }
      open.delete(current); closed.add(current);
      const x = current % cols, y = Math.floor(current / cols);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if ((!dx && !dy) || x + dx < 0 || x + dx >= cols || y + dy < 0 || y + dy >= rows) continue;
        const next = (y + dy) * cols + x + dx;
        if (closed.has(next) || !valid(next)) continue;
        const key = Math.min(current, next) + ":" + Math.max(current, next);
        if (!edges.has(key)) edges.set(key, clearSegment(points[current], points[next], barriers, clearance));
        if (!edges.get(key)) continue;
        const cost = costs.get(current)! + distance(points[current], points[next]);
        if (cost < (costs.get(next) ?? Infinity)) { costs.set(next, cost); previous.set(next, current); open.add(next); }
      }
    }
    return null;
  };
}
