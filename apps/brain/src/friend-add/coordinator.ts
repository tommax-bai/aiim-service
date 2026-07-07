/**
 * 加友闭环协调器（change friend-add-closed-loop task 4.x）。
 * 把「受理去重 → 选号 → 风控闸 → 发起 → 后置校验 → 等待通过 → 超时判失败 → 被动受理」
 * 拆成一组订阅 EventBus 的微决策处理器（对应角色 FriendRequestIntake / AddChannelResolver /
 * AddFriendRiskGate / AddFriendExecutor(下发) / FriendRequestVerifier / 等待通过 / InboundFriendReviewer）。
 *
 * 红线（AC-ADD）：
 *  - op.result ok 只进 pending，绝不判成功、绝不触发首触。
 *  - first_touch.needed 只在收到 friend.accepted（好友列表实证）后发出。
 *  - 超时/被拒判失败；连续失败到顶升级停手；本协调器不自动重发（绝不无限重发）。
 *  - 撞配额只背压（deferred），绝不自升风控状态（record 返 false 即退避）。
 */
import type { EventBus, RiskStatus } from '@aiim/kernel';
import { targetKey, type FriendAddFailReason, type FriendAddTask } from '@aiim/contracts';
import type { FriendAddStore } from '@aiim/store';
import type { AccountRuntime, BrainEventMap, FriendAddConfig, GatewayPort } from './types';

const STATUS_TEMPO: Record<RiskStatus, number> = { normal: 1, warned: 1.3, restricted: 1.6, frozen: 2 };

const DAY_MS = 24 * 60 * 60_000;
// 选号打分权重：号龄（养号期降权）/ 垂类匹配 / 剩余配额负载均衡。
const SELECT_W_AGE = 0.5;
const SELECT_W_VERTICAL = 0.3;
const SELECT_W_REMAINING = 0.2;

export interface FriendAddLoopOptions {
  bus: EventBus<BrainEventMap>;
  gateway: GatewayPort;
  store: FriendAddStore;
  /** 当前受管账号快照（每次取，支持热增减）。 */
  accounts: () => AccountRuntime[];
  config: FriendAddConfig;
  clock?: () => number;
  newId?: () => string;
}

export interface FriendAddLoopHandle {
  /** 由巡视/调度周期性调用：把超时未通过的 pending 任务判失败（AnomalyPatrol 驱动）。 */
  sweepTimeouts(now: number): void;
  dispose(): void;
}

export function createFriendAddLoop(opts: FriendAddLoopOptions): FriendAddLoopHandle {
  const { bus, gateway, store, accounts, config } = opts;
  const clock = opts.clock ?? Date.now;
  let seq = 0;
  const newId = opts.newId ?? (() => `t${(seq += 1)}`);
  const unsubs: Array<() => void> = [];

  function accountOf(accountId: string | undefined): AccountRuntime | undefined {
    return accountId ? accounts().find((a) => a.accountId === accountId) : undefined;
  }

  /** 选号打分：号龄（<trustDays 养号期降权）+ 垂类匹配 + 剩余配额负载均衡。分越高越优先。 */
  function scoreAccount(a: AccountRuntime, task: FriendAddTask, now: number): number {
    const ageDays = a.createdAt === undefined ? Infinity : Math.max(0, (now - a.createdAt) / DAY_MS);
    const ageScore = Math.min(ageDays / Math.max(1, config.trustDays), 1);
    const verticalMatch = task.vertical && a.verticals?.includes(task.vertical) ? 1 : 0;
    const dayQuota = a.risk.effectiveQuotas().day.add_friend;
    const remainingRatio = dayQuota > 0 ? a.risk.dailyRemaining('add_friend') / dayQuota : 0;
    return SELECT_W_AGE * ageScore + SELECT_W_VERTICAL * verticalMatch + SELECT_W_REMAINING * remainingRatio;
  }

  function selectAccount(task: FriendAddTask): AccountRuntime | undefined {
    const eligible = accounts().filter((a) => a.risk.canDo('add_friend'));
    if (eligible.length === 0) return undefined;
    // 外部显式指定承接账号：可用则尊重。
    if (task.accountId) {
      const pref = eligible.find((a) => a.accountId === task.accountId);
      if (pref) return pref;
    }
    const now = clock();
    let best: AccountRuntime | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const a of eligible) {
      const s = scoreAccount(a, task, now);
      if (s > bestScore) {
        bestScore = s;
        best = a;
      }
    }
    return best;
  }

  /** 单账号连续加友失败累计到顶 → 升级停手（诚实置风控态 + 告警）。 */
  function onFailure(accountId: string | undefined): void {
    if (!accountId) return;
    const n = store.bumpConsecutiveFailures(accountId);
    if (n >= config.maxConsecutiveFailures) {
      void accountOf(accountId)?.risk.applySignal({ kind: 'light' });
      bus.emit('alert', { accountId, kind: 'friend_add_systemic_failure', detail: `连续加友失败 ${n} 次，升级停手` });
      store.resetConsecutiveFailures(accountId);
    }
  }

  function failTask(task: FriendAddTask, reason: FriendAddFailReason): void {
    store.update({ ...task, state: 'failed', failReason: reason, updatedAt: clock() });
    bus.emit('friend.add.failed', { taskId: task.taskId, accountId: task.accountId, reason });
    // 通过率统计：仅「对方结果」（被拒/超时未过）计入，不含 svr_fail/no_target 系统失败。
    if ((reason === 'rejected_by_peer' || reason === 'timeout') && task.accountId) {
      void accountOf(task.accountId)?.risk.note('add_friend_rejected');
    }
    onFailure(task.accountId);
  }

  // —— FriendRequestIntake：受理 + 去重 ——
  unsubs.push(
    bus.on('friend.add_requested', (ev) => {
      const key = targetKey(ev.target);
      if (!key) {
        bus.emit('friend.add.rejected', { requestId: ev.requestId, reason: 'no_target' });
        return;
      }
      if (store.findActiveByTargetKey(key)) return; // 已有活跃任务 → 幂等，不新建
      if (store.isBlacklisted(key)) {
        bus.emit('friend.add.rejected', { requestId: ev.requestId, reason: 'blacklist' });
        return;
      }
      if (store.isAlreadyFriend(key)) {
        bus.emit('friend.add.rejected', { requestId: ev.requestId, reason: 'already_friend' });
        return;
      }
      const now = clock();
      const task: FriendAddTask = {
        taskId: newId(),
        accountId: ev.preferredAccountId,
        target: ev.target,
        channel: ev.channel,
        verifyText: ev.verifyText,
        sourceTag: ev.sourceTag,
        vertical: ev.vertical,
        state: 'received',
        createdAt: now,
        updatedAt: now,
      };
      store.create(task);
      bus.emit('friend.add.candidate', { taskId: task.taskId });
    }),
  );

  // —— 选号 + 加友风控闸 ——
  unsubs.push(
    bus.on('friend.add.candidate', ({ taskId }) => {
      const task = store.get(taskId);
      if (!task) return;
      const acct = selectAccount(task);
      if (!acct) {
        store.update({ ...task, state: 'deferred', updatedAt: clock() });
        bus.emit('friend.add.deferred', { taskId, reason: 'no_quota' });
        return;
      }
      const gate = acct.risk.explain('add_friend');
      if (!gate.allowed) {
        // 撞配额/状态：背压 deferred，绝不自升风控态。
        store.update({ ...task, accountId: acct.accountId, state: 'deferred', updatedAt: clock() });
        bus.emit('friend.add.deferred', { taskId, reason: gate.reason ?? 'risk' });
        return;
      }
      const status = acct.risk.getState().status;
      const preAddDelayMs = Math.round(config.preAddDelayBaseMs * (STATUS_TEMPO[status] ?? 1));
      store.update({ ...task, accountId: acct.accountId, state: 'risk_gated', updatedAt: clock() });
      bus.emit('friend.add.authorized', { taskId, preAddDelayMs });
    }),
  );

  // —— AddFriendExecutor：发起（记账占额 + 下发 gateway）——
  unsubs.push(
    bus.on('friend.add.authorized', async ({ taskId, preAddDelayMs }) => {
      const task = store.get(taskId);
      if (!task || !task.accountId) return;
      const acct = accountOf(task.accountId);
      if (!acct) return;
      // 记账占额（每次尝试都命中平台）；被拒即背压，绝不自升状态。
      const reserved = await acct.risk.record('add_friend');
      if (!reserved) {
        store.update({ ...task, state: 'deferred', updatedAt: clock() });
        bus.emit('friend.add.deferred', { taskId, reason: 'quota_raced' });
        return;
      }
      const requestId = newId();
      store.update({ ...task, state: 'dispatched', requestId, updatedAt: clock() });
      gateway.send({
        type: 'friend.add',
        payload: {
          accountId: task.accountId,
          taskId,
          requestId,
          target: task.target,
          channel: task.channel ?? 'phone',
          verifyText: task.verifyText,
          preAddDelayMs,
        },
      });
    }),
  );

  // —— FriendRequestVerifier：后置校验「请求真发出」——
  unsubs.push(
    bus.on('op.result', (ev) => {
      if (ev.command !== 'friend.add') return;
      const task = store.findByRequestId(ev.requestId);
      if (!task || task.state !== 'dispatched') return;
      if (!ev.ok || ev.isSvrFail) {
        failTask(task, ev.isSvrFail ? 'svr_fail' : 'no_target');
        return;
      }
      // 请求真发出 → pending。红线：绝不在此判成功、绝不触发首触。
      store.update({ ...task, state: 'pending', updatedAt: clock() });
    }),
  );

  // —— 等待通过：只有 friend.accepted（好友列表实证）才判 accepted 并交棒首触 ——
  unsubs.push(
    bus.on('friend.accepted', (ev) => {
      if (ev.taskId) {
        const task = store.get(ev.taskId);
        if (!task || task.state === 'accepted') return;
        store.update({ ...task, state: 'accepted', updatedAt: clock() });
        if (task.accountId) {
          store.resetConsecutiveFailures(task.accountId);
          void accountOf(task.accountId)?.risk.note('add_friend_accepted'); // 通过率统计
        }
      }
      bus.emit('first_touch.needed', {
        accountId: ev.accountId,
        wxid: ev.wxid,
        conversationId: ev.conversationId,
        taskId: ev.taskId,
      });
    }),
  );

  unsubs.push(
    bus.on('friend.rejected', (ev) => {
      const task = store.get(ev.taskId);
      if (!task || task.state === 'accepted' || task.state === 'failed' || task.state === 'rejected') return;
      failTask(task, 'rejected_by_peer');
    }),
  );

  unsubs.push(
    bus.on('friend.expired', (ev) => {
      const task = store.get(ev.taskId);
      if (!task || task.state === 'accepted' || task.state === 'failed' || task.state === 'rejected') return;
      failTask(task, 'timeout');
    }),
  );

  // —— InboundFriendReviewer：被动加友受理 ——
  unsubs.push(
    bus.on('friend.request_received', (ev) => {
      const suspicious = (config.suspiciousKeywords ?? []).some((k) => (ev.verifyText ?? '').includes(k));
      if (suspicious) {
        bus.emit('alert', {
          accountId: ev.accountId,
          kind: 'friend_request_manual_review',
          detail: `可疑申请挂人审: ${ev.fromWxid ?? ''}`,
        });
        return;
      }
      gateway.send({ type: 'friend.accept', payload: { accountId: ev.accountId, requestId: ev.requestId } });
    }),
  );

  return {
    sweepTimeouts(now: number) {
      for (const task of store.listPending()) {
        if (now - task.updatedAt > config.pendingTimeoutMs) {
          failTask(task, 'timeout');
        }
      }
    },
    dispose() {
      for (const u of unsubs) u();
      unsubs.length = 0;
    },
  };
}
