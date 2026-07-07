/**
 * 拟人化时长（领域无关，从 aidcp-edge/src/humanize/timing.ts 复制核心）。
 * 云端给中心值，执行端用 jitterAround 叠**乘性 lognormal 抖动**（median = 中心值），
 * 避免两账号分毫不差、避免机械均匀。rng 可注入以便确定性测试。
 */

export type Rng = () => number;

/** 标准正态采样（Box–Muller）。 */
export function gaussian(rng: Rng = Math.random): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface JitterOptions {
  /** lognormal 的 sigma（越大越长尾）。默认 0.35。 */
  sigma?: number;
  /** 抖动后下限（ms）。保证非零、抬不穿。 */
  min?: number;
  /** 抖动后上限（ms）。 */
  max?: number;
  rng?: Rng;
}

/**
 * 围绕中心值叠乘性 lognormal 抖动：返回 `center * exp(sigma * N(0,1))`（median = center），
 * 恒正、可 clamp。中心值 ≤ 0 直接返回 0。
 */
export function jitterAround(centerMs: number, opts: JitterOptions = {}): number {
  if (centerMs <= 0) return 0;
  const sigma = opts.sigma ?? 0.35;
  const rng = opts.rng ?? Math.random;
  const mult = Math.exp(sigma * gaussian(rng));
  let v = centerMs * mult;
  if (opts.min !== undefined) v = Math.max(opts.min, v);
  if (opts.max !== undefined) v = Math.min(opts.max, v);
  return Math.round(v);
}
