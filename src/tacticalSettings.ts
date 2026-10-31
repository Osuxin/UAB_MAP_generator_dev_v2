export const TACTICAL_FIELDS = [
  { key: "breakPressure", label: "ブレイク", description: "相手の初動を狙える射線の広さ。自分の初動で生まれる射線も含みます", low: "初動を狙える射線が少ない", mid: "初動を狙える射線は中程度", high: "初動を広く狙える" },
  { key: "advance", label: "上がりやすさ", description: "相手の射線にさらされずに前進できる度合い", low: "前進のリスクを許容", mid: "安全性とリスクを両立", high: "安全に前進しやすい" },
  { key: "support", label: "援護", description: "前進を妨げる相手を、残る味方が射線で抑えられる度合い", low: "援護で通せる経路が少ない", mid: "援護のしやすさは中程度", high: "味方の援護で前進しやすい" },
  { key: "gain", label: "前進メリット", description: "前進によって得点や相手の経路への射線が増える度合い", low: "前進による利益は小さい", mid: "前進による利益は中程度", high: "前進による利益が大きい" },
  { key: "retake", label: "アグレッシブの取り返し", description: "自陣に侵入した相手を、異なる方向から攻撃できる度合い", low: "侵入した相手が守り切りやすい", mid: "取り返しやすさは中程度", high: "複数方向から取り返しやすい" },
  { key: "cross", label: "クロスの強さ", description: "クロス・Vクロスで相手の移動経路を抑える度合い。攻め側では前進先、守り側では後方を重視", low: "クロスによる抑制は弱め", mid: "クロスによる抑制は中程度", high: "クロスで経路を強く抑える" },
] as const;

export type TacticalKey = typeof TACTICAL_FIELDS[number]["key"];
export type TacticalValues = Record<TacticalKey, number>;
export type TacticalConfig = TacticalValues & { playStyle: number };

// Initial tuning hypotheses, not official sport rules. Left = attack, right = defense.
const ATTACK: TacticalValues = { breakPressure: 35, advance: 65, support: 75, gain: 80, retake: 75, cross: 75 };
const DEFENSE: TacticalValues = { breakPressure: 75, advance: 25, support: 35, gain: 40, retake: 25, cross: 80 };
export function styleSettings(value: number): TacticalConfig {
  const playStyle = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 50));
  const t = playStyle / 100;
  const targets = Object.fromEntries(TACTICAL_FIELDS.map(({ key }) => [key, Math.round(ATTACK[key] * (1 - t) + DEFENSE[key] * t)])) as TacticalValues;
  return { ...targets, playStyle };
}
export function styleLabel(value: number): string {
  return value < 40 ? "攻め寄り" : value > 60 ? "守り寄り" : "バランス";
}
