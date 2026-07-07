/**
 * @aiim/kernel — 领域无关机制（从 AIDCP 复制内联 + 泛型化）。
 * 禁止反向依赖 apps/* 或 @aiim/contracts（机制不认识任何具体域）。
 */
export { EventBus } from './event-bus/index';

export { gaussian, jitterAround } from './humanize/timing';
export type { Rng, JitterOptions } from './humanize/timing';

export { RiskController } from './risk/risk-controller';
export type { RiskControllerOptions, CanDoResult } from './risk/risk-controller';
export { RiskStateMachine, createRiskState, WARNED_RECOVERY_MS, RESTRICTED_RECOVERY_MS } from './risk/risk-state-machine';
export { SlidingWindowCounter, WINDOW_MS } from './risk/sliding-window-counter';
export { deriveWindowQuotas, scaleWindowQuotas, restrictedQuotas, QUOTA_MAX } from './risk/quotas';
export {
  RISK_QUOTA_LEVELS,
  RISK_STATUSES,
} from './risk/types';
export type {
  RiskQuotaLevel,
  RiskStatus,
  RiskWindow,
  RiskState,
  RiskSignal,
  RiskSignalKind,
  RiskStore,
  QuotaProvider,
  RiskPolicy,
  ActionQuota,
  WindowQuotas,
  CounterEvent,
} from './risk/types';
