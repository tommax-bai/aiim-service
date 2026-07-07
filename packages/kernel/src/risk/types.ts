/**
 * 风控内核类型（领域无关）。从 aidcp-cloud/src/risk/types.ts 复制并**泛型化**：
 * 动作集合 `A` 由各域注入（微信域见 @aiim/contracts 的 WECHAT_RISK_POLICY），
 * 三处 XHS 浅耦合（restricted 只放行 view / warned 暂停 publish / likeRatio 护栏）
 * 抽成 RiskPolicy 的策略字段，内核不再认识任何具体动作。
 */

export const RISK_QUOTA_LEVELS = ['conservative', 'normal', 'aggressive'] as const;
export type RiskQuotaLevel = (typeof RISK_QUOTA_LEVELS)[number];

export const RISK_STATUSES = ['normal', 'warned', 'restricted', 'frozen'] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];

export type RiskWindow = 'minute' | 'hour' | 'day';

export type ActionQuota<A extends string> = Record<A, number>;
export type WindowQuotas<A extends string> = Record<RiskWindow, ActionQuota<A>>;

export interface RiskState {
  accountId: string;
  status: RiskStatus;
  quotaLevel: RiskQuotaLevel;
  signalCount: number;
  lastSignalAt: number | null;
  statusSince: number;
  updatedAt: number;
}

export type RiskSignalKind =
  | 'light'
  // 注意：不含 'quota_exceeded'——撞自己的速率配额是节奏背压、不是风控信号。
  // 威胁态只由平台可观测信号 + 运营手动信号驱动。
  | 'confirmed'
  | 'fatal'
  | 'recovered'
  | 'manual_unfreeze'
  | 'manual_restrict' // normal/warned → restricted
  | 'manual_freeze' // any → frozen
  | 'operator_override_recover'; // 绕过恢复窗口强制 → normal（特权，需审计理由）

export interface RiskSignal {
  kind: RiskSignalKind;
  at?: number;
  /** 运营操作的审计理由（operator_override_recover 等特权操作必填）。 */
  reason?: string;
}

export interface CounterEvent<A extends string> {
  action: A;
  occurredAt: number;
  count: number;
}

export interface RiskStore<A extends string> {
  init?(): Promise<void>;
  loadCounters(accountId: string, since: number): Promise<CounterEvent<A>[]>;
  appendCounter(accountId: string, action: A, occurredAt: number): Promise<void>;
  loadState(accountId: string): Promise<RiskState | null>;
  saveState(state: RiskState): Promise<void>;
  close?(): Promise<void>;
}

/** 配额数字提供者：按档位给出三窗口生效数字（热加载库值）。缺省回落 policy 写死默认。 */
export interface QuotaProvider<A extends string> {
  windowQuotasFor(level: RiskQuotaLevel): WindowQuotas<A>;
}

/**
 * 域策略：把内核里原本对 XHS 写死的三处判定抽成注入字段。各域提供自己的一份。
 * - `restrictedAllowedActions`：`restricted` 态仅放行的动作（XHS 版是只放行 `view`）。
 * - `warnedPausedActions`：`warned` 态暂停的高风险动作（XHS 版是暂停 `publish`）。
 * - `ratioGuard`：可选的比例护栏（XHS 版是 like/view ≤ 0.35）。返回 true 表示放行。
 */
export interface RiskPolicy<A extends string> {
  readonly actions: readonly A[];
  readonly quotas: Record<RiskQuotaLevel, ActionQuota<A>>;
  readonly minuteBurstCap: ActionQuota<A>;
  readonly hourBurstCap: ActionQuota<A>;
  readonly restrictedAllowedActions: readonly A[];
  readonly warnedPausedActions: readonly A[];
  readonly ratioGuard?: (action: A, count: (a: A, window: RiskWindow) => number) => boolean;
}
