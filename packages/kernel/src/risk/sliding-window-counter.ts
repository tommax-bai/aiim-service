/**
 * 滑动窗口计数器（领域无关，从 aidcp-cloud 复制并泛型化到动作集合 `A`）。
 * minute / hour / day 三窗滚动计数；构造时传入动作全集供 counts()/snapshot() 枚举。
 */
import type { CounterEvent, RiskWindow } from './types';

const WINDOW_MS: Record<RiskWindow, number> = {
  minute: 60_000,
  hour: 60 * 60_000,
  day: 24 * 60 * 60_000,
};

export class SlidingWindowCounter<A extends string> {
  private readonly events: CounterEvent<A>[] = [];
  private readonly clock: () => number;
  private readonly actions: readonly A[];

  constructor(options: { actions: readonly A[]; clock?: () => number; initialEvents?: CounterEvent<A>[] }) {
    this.actions = options.actions;
    this.clock = options.clock ?? Date.now;
    if (options.initialEvents) this.events.push(...options.initialEvents);
    this.prune();
  }

  record(action: A, at = this.clock(), count = 1): void {
    this.events.push({ action, occurredAt: at, count });
    this.prune(at);
  }

  count(action: A, window: RiskWindow, at = this.clock()): number {
    const since = at - WINDOW_MS[window];
    return this.events
      .filter((event) => event.action === action && event.occurredAt > since && event.occurredAt <= at)
      .reduce((sum, event) => sum + event.count, 0);
  }

  retryAfterMs(action: A, window: RiskWindow, quota: number, at = this.clock()): number | undefined {
    if (quota <= 0) return undefined;
    const since = at - WINDOW_MS[window];
    const active = this.events
      .filter((event) => event.action === action && event.occurredAt > since && event.occurredAt <= at)
      .sort((a, b) => a.occurredAt - b.occurredAt);
    const total = active.reduce((sum, event) => sum + event.count, 0);
    if (total < quota) return 0;

    let remaining = total;
    for (const event of active) {
      remaining -= event.count;
      if (remaining < quota) {
        return Math.max(0, event.occurredAt + WINDOW_MS[window] - at);
      }
    }
    return 0;
  }

  counts(window: RiskWindow, at = this.clock()): Record<A, number> {
    return Object.fromEntries(this.actions.map((action) => [action, this.count(action, window, at)])) as Record<A, number>;
  }

  snapshot(at = this.clock()): Record<RiskWindow, Record<A, number>> {
    return {
      minute: this.counts('minute', at),
      hour: this.counts('hour', at),
      day: this.counts('day', at),
    };
  }

  prune(at = this.clock()): void {
    const oldest = at - WINDOW_MS.day;
    while (this.events.length > 0 && this.events[0].occurredAt <= oldest) this.events.shift();
  }
}

export { WINDOW_MS };
