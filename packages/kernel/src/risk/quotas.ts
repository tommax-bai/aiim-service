/**
 * 配额派生/缩放/受限（领域无关，从 aidcp-cloud 复制并泛型化）。
 * 三处 XHS 浅耦合的换靶：
 *  - deriveWindowQuotas 从 policy.quotas + burst caps 派生（XHS 版是写死 DAILY_QUOTAS）。
 *  - restrictedQuotas 保留 policy.restrictedAllowedActions（XHS 版是保留 view=zeroInteractions）。
 */
import type { ActionQuota, RiskPolicy, RiskQuotaLevel, WindowQuotas } from './types';

/** 限额数字的合理上限（校验用，防误填天文数字击穿滑窗比较）。 */
export const QUOTA_MAX = 100_000;

export function deriveWindowQuotas<A extends string>(policy: RiskPolicy<A>, level: RiskQuotaLevel): WindowQuotas<A> {
  const day = policy.quotas[level];
  return {
    minute: mapQuota(policy.actions, day, (a, d) => (d <= 0 ? 0 : Math.max(1, Math.min(policy.minuteBurstCap[a], Math.ceil(d / 20))))),
    hour: mapQuota(policy.actions, day, (a, d) => (d <= 0 ? 0 : Math.max(1, Math.min(policy.hourBurstCap[a], Math.ceil(d / 4))))),
    day: { ...day },
  };
}

export function scaleWindowQuotas<A extends string>(policy: RiskPolicy<A>, quotas: WindowQuotas<A>, factor: number): WindowQuotas<A> {
  const s = (q: ActionQuota<A>) => mapQuota(policy.actions, q, (_a, v) => Math.max(0, Math.ceil(v * factor)));
  return { minute: s(quotas.minute), hour: s(quotas.hour), day: s(quotas.day) };
}

/** restricted 态：只保留 policy.restrictedAllowedActions 的配额，其余清零。 */
export function restrictedQuotas<A extends string>(policy: RiskPolicy<A>, base: WindowQuotas<A>): WindowQuotas<A> {
  const keep = new Set<A>(policy.restrictedAllowedActions);
  const z = (q: ActionQuota<A>) => mapQuota(policy.actions, q, (a, v) => (keep.has(a) ? v : 0));
  return { minute: z(base.minute), hour: z(base.hour), day: z(base.day) };
}

function mapQuota<A extends string>(
  actions: readonly A[],
  quota: ActionQuota<A>,
  mapper: (action: A, value: number) => number,
): ActionQuota<A> {
  return Object.fromEntries(actions.map((action) => [action, mapper(action, quota[action])])) as ActionQuota<A>;
}
