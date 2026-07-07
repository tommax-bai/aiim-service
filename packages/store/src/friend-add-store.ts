/**
 * 加友任务存储（change friend-add-closed-loop task 5.x）。
 * 接口 + 内存实现。生产接 PG（跨重启不丢），接口不变。
 */
import { targetKey, type FriendAddTask } from '@aiim/contracts';

const TERMINAL: ReadonlySet<string> = new Set(['accepted', 'failed', 'rejected']);

export interface FriendAddStore {
  create(task: FriendAddTask): void;
  get(taskId: string): FriendAddTask | undefined;
  update(task: FriendAddTask): void;
  /** 活跃(非终态)任务按 targetKey 查，用于跨号去重。 */
  findActiveByTargetKey(key: string): FriendAddTask | undefined;
  /** 按 requestId 查（op.result / 后续事件关联）。 */
  findByRequestId(requestId: string): FriendAddTask | undefined;
  /** 所有 pending 任务，供超时巡视。 */
  listPending(): FriendAddTask[];
  isBlacklisted(key: string): boolean;
  /** 目标是否已是任一受管账号的好友（避免重复添加）。 */
  isAlreadyFriend(key: string): boolean;
  /** 账号连续加友失败计数 +1，返回累计值。 */
  bumpConsecutiveFailures(accountId: string): number;
  resetConsecutiveFailures(accountId: string): void;
}

export interface InMemoryStoreSeed {
  blacklist?: Iterable<string>;
  friends?: Iterable<string>;
}

export class InMemoryFriendAddStore implements FriendAddStore {
  private readonly tasks = new Map<string, FriendAddTask>();
  private readonly blacklist: Set<string>;
  private readonly friends: Set<string>;
  private readonly consecutiveFailures = new Map<string, number>();

  constructor(seed: InMemoryStoreSeed = {}) {
    this.blacklist = new Set(seed.blacklist ?? []);
    this.friends = new Set(seed.friends ?? []);
  }

  create(task: FriendAddTask): void {
    this.tasks.set(task.taskId, { ...task });
  }

  get(taskId: string): FriendAddTask | undefined {
    const t = this.tasks.get(taskId);
    return t ? { ...t } : undefined;
  }

  update(task: FriendAddTask): void {
    this.tasks.set(task.taskId, { ...task });
  }

  findActiveByTargetKey(key: string): FriendAddTask | undefined {
    for (const t of this.tasks.values()) {
      if (TERMINAL.has(t.state)) continue;
      if (targetKey(t.target) === key) return { ...t };
    }
    return undefined;
  }

  findByRequestId(requestId: string): FriendAddTask | undefined {
    for (const t of this.tasks.values()) {
      if (t.requestId === requestId) return { ...t };
    }
    return undefined;
  }

  listPending(): FriendAddTask[] {
    return [...this.tasks.values()].filter((t) => t.state === 'pending').map((t) => ({ ...t }));
  }

  isBlacklisted(key: string): boolean {
    return this.blacklist.has(key);
  }

  isAlreadyFriend(key: string): boolean {
    return this.friends.has(key);
  }

  bumpConsecutiveFailures(accountId: string): number {
    const n = (this.consecutiveFailures.get(accountId) ?? 0) + 1;
    this.consecutiveFailures.set(accountId, n);
    return n;
  }

  resetConsecutiveFailures(accountId: string): void {
    this.consecutiveFailures.set(accountId, 0);
  }
}
