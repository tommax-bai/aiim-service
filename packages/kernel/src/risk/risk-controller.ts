/**
 * 风控权威（领域无关，从 aidcp-cloud 复制并泛型化为 RiskController<A>）。
 * 三处 XHS 硬编码换成 RiskPolicy 注入：
 *   - restricted 只放行 `view`         → policy.restrictedAllowedActions
 *   - warned 暂停 `publish`            → policy.warnedPausedActions
 *   - like/view ≤ 0.35 比例护栏        → policy.ratioGuard
 * 红线不变量保留：撞自己配额是「节奏背压」，record() 只返 false、绝不 applySignal 自升威胁态。
 */
import { deriveWindowQuotas, restrictedQuotas, scaleWindowQuotas } from './quotas';
import { createRiskState, RiskStateMachine } from './risk-state-machine';
import { SlidingWindowCounter, WINDOW_MS } from './sliding-window-counter';
import type { QuotaProvider, RiskPolicy, RiskQuotaLevel, RiskSignal, RiskState, RiskStore, RiskWindow, WindowQuotas } from './types';

export interface RiskControllerOptions<A extends string> {
  policy: RiskPolicy<A>;
  accountId?: string;
  quotaLevel?: RiskQuotaLevel;
  clock?: () => number;
  store?: RiskStore<A>;
  initialState?: RiskState;
  quotaProvider?: QuotaProvider<A>;
}

export interface CanDoResult {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
}

export class RiskController<A extends string> {
  private readonly policy: RiskPolicy<A>;
  private readonly accountId: string;
  private readonly clock: () => number;
  private readonly counter: SlidingWindowCounter<A>;
  private readonly stateMachine = new RiskStateMachine();
  private readonly store?: RiskStore<A>;
  private readonly quotaProvider?: QuotaProvider<A>;
  private state: RiskState;
  /** 每账号串行化：所有改 state + saveState 的写经此链，避免并发 read-modify-write 丢更新。 */
  private mutationChain: Promise<unknown> = Promise.resolve();

  constructor(options: RiskControllerOptions<A>) {
    const now = options.clock?.() ?? Date.now();
    this.policy = options.policy;
    this.accountId = options.accountId ?? '__unbound__';
    this.clock = options.clock ?? Date.now;
    this.store = options.store;
    this.state = options.initialState ?? createRiskState(this.accountId, now);
    this.state.quotaLevel = options.quotaLevel ?? this.state.quotaLevel;
    this.counter = new SlidingWindowCounter<A>({ actions: this.policy.actions, clock: this.clock });
    this.quotaProvider = options.quotaProvider;
  }

  static async create<A extends string>(options: RiskControllerOptions<A>): Promise<RiskController<A>> {
    const accountId = options.accountId ?? '__unbound__';
    const now = options.clock?.() ?? Date.now();
    await options.store?.init?.();
    const state = (await options.store?.loadState(accountId)) ?? options.initialState ?? createRiskState(accountId, now);
    const events = (await options.store?.loadCounters(accountId, now - WINDOW_MS.day)) ?? [];
    const controller = new RiskController<A>({ ...options, accountId, initialState: state });
    for (const event of events) controller.counter.record(event.action, event.occurredAt, event.count);
    return controller;
  }

  canDo(action: A): boolean {
    return this.explain(action).allowed;
  }

  explain(action: A): CanDoResult {
    if (this.state.status === 'frozen') return { allowed: false, reason: 'state:frozen' };
    if (this.state.status === 'restricted' && !this.policy.restrictedAllowedActions.includes(action)) {
      return { allowed: false, reason: 'state:restricted' };
    }
    if (this.state.status === 'warned' && this.policy.warnedPausedActions.includes(action)) {
      return { allowed: false, reason: 'state:warned_paused' };
    }

    const quotas = this.effectiveQuotas();
    for (const window of ['minute', 'hour', 'day'] as const) {
      const quota = quotas[window][action];
      if (this.counter.count(action, window) >= quota) {
        return {
          allowed: false,
          reason: `quota:${window}`,
          retryAfterMs: this.counter.retryAfterMs(action, window, quota),
        };
      }
    }
    if (this.policy.ratioGuard && !this.policy.ratioGuard(action, (a, w) => this.counter.count(a, w))) {
      return { allowed: false, reason: 'ratio' };
    }
    return { allowed: true };
  }

  /** 某动作当日剩余配额。当前被拦（状态/任一窗口耗尽）→ 0。 */
  dailyRemaining(action: A): number {
    if (!this.canDo(action)) return 0;
    const quotas = this.effectiveQuotas();
    return Math.max(0, quotas.day[action] - this.counter.count(action, 'day'));
  }

  quotaReleaseAfterMs(action: A, window: RiskWindow): number | undefined {
    const quota = this.effectiveQuotas()[window][action];
    if (this.counter.count(action, window) < quota) return 0;
    return this.counter.retryAfterMs(action, window, quota);
  }

  async record(action: A): Promise<boolean> {
    // 撞自己的速率配额是「节奏背压」，不是风控信号：被拒只返 false，绝不 applySignal 自升威胁态。
    if (!this.canDo(action)) {
      return false;
    }
    const now = this.clock();
    this.counter.record(action, now);
    await this.store?.appendCounter(this.accountId, action, now);
    return true;
  }

  /**
   * 记录一个「观测/结果」事件到滑窗（**不经 canDo 门控**），供比例护栏/统计用（如加友通过率）。
   * 与 record() 区别：record 是「我要做一个受限动作、占额」；note 是「某结果发生了、记一笔」，永远记。
   */
  async note(action: A): Promise<void> {
    const now = this.clock();
    this.counter.record(action, now);
    await this.store?.appendCounter(this.accountId, action, now);
  }

  getState(): RiskState {
    return { ...this.state };
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutationChain.then(fn, fn);
    this.mutationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async applySignal(signal: RiskSignal): Promise<RiskState> {
    return this.enqueue(async () => {
      this.state = this.stateMachine.transition(this.state, signal, signal.at ?? this.clock());
      await this.store?.saveState(this.state);
      return this.getState();
    });
  }

  async setQuotaLevel(level: RiskQuotaLevel): Promise<RiskState> {
    return this.enqueue(async () => {
      this.state = { ...this.state, quotaLevel: level, updatedAt: this.clock() };
      await this.store?.saveState(this.state);
      return this.getState();
    });
  }

  effectiveQuotas(): WindowQuotas<A> {
    const base = (level: RiskQuotaLevel): WindowQuotas<A> =>
      this.quotaProvider?.windowQuotasFor(level) ?? deriveWindowQuotas(this.policy, level);
    if (this.state.status === 'warned') return scaleWindowQuotas(this.policy, base('conservative'), 0.7);
    if (this.state.status === 'restricted') return restrictedQuotas(this.policy, base('conservative'));
    if (this.state.status === 'frozen') return scaleWindowQuotas(this.policy, base('conservative'), 0);
    return base(this.state.quotaLevel);
  }

  counts() {
    return this.counter.snapshot();
  }
}
