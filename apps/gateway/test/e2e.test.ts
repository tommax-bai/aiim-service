/**
 * 端到端结构闭环（change friend-add-closed-loop task 7.2 + 3.3 + 4.7）：
 * 外部指令 → brain 协调器 → gateway → fake 服务商 → op.result 归一 → pending →
 * 模拟 2131 → sync_contacts 实证确认 → friend.accepted → 交棒首触。真服务商到位只换 Provider 实现。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EventBus, RiskController } from '@aiim/kernel';
import { WECHAT_RISK_POLICY, type WechatRiskAction } from '@aiim/contracts';
import { InMemoryFriendAddStore } from '@aiim/store';
import { createFriendAddLoop, DEFAULT_FRIEND_ADD_CONFIG, type AccountRuntime, type BrainEventMap } from '@aiim/brain';
import { createGateway } from '../src/gateway';
import { FakeProvider } from '../src/provider';

const CLOCK = () => 1_700_000_000_000;

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function wire(opts: { provider?: FakeProvider; accountIds?: string[] } = {}) {
  const bus = new EventBus<BrainEventMap>();
  const store = new InMemoryFriendAddStore();
  const provider = opts.provider ?? new FakeProvider();
  // 测试注入立即 sleep（否则默认 preAddDelay ~90s 会挂）；节奏正确性单独测。
  const gateway = createGateway({ bus, provider, pacing: { sleep: () => Promise.resolve() } });
  const accounts: AccountRuntime[] = (opts.accountIds ?? ['acc1']).map((accountId) => ({
    accountId,
    risk: new RiskController<WechatRiskAction>({ policy: WECHAT_RISK_POLICY, accountId, quotaLevel: 'aggressive', clock: CLOCK }),
  }));
  const firstTouch: BrainEventMap['first_touch.needed'][] = [];
  bus.on('first_touch.needed', (e) => { firstTouch.push(e); });
  const loop = createFriendAddLoop({ bus, gateway: gateway.port, store, accounts: () => accounts, config: DEFAULT_FRIEND_ADD_CONFIG, clock: CLOCK });
  return { bus, store, provider, gateway, accounts, firstTouch, loop };
}

test('E2E: 外部加微 → 加友 → 回执进 pending → 2131+sync 实证 → 首触', async () => {
  const h = wire();
  h.bus.emit('friend.add_requested', { requestId: 'ext1', target: { phone: '13800000000' } });
  await settle();

  const task = h.store.findActiveByTargetKey('phone:13800000000');
  assert.ok(task, '任务已建');
  assert.equal(task!.state, 'pending', '回执 ok 只进 pending');
  assert.equal(h.firstTouch.length, 0, '未实证前绝不触发首触');
  const taskId = task!.taskId;

  // 模拟对方通过 → 2131 → gateway sync_contacts 确认 → friend.accepted
  h.provider.simulatePeerAccept('acc1', 'wx_13800000000');
  await settle();

  assert.equal(h.firstTouch.length, 1, '实证确认后交棒一次首触');
  assert.equal(h.firstTouch[0]!.wxid, 'wx_13800000000');
  assert.equal(h.firstTouch[0]!.conversationId, 'S:wx_13800000000');
  assert.equal(h.store.get(taskId)!.state, 'accepted');
});

test('E2E: 服务器失败(is_svr_fail) → 判失败、不进 pending、不确认、不首触', async () => {
  const provider = new FakeProvider({ addResult: () => ({ ok: true, isSvrFail: true, wxid: 'wx_x' }) });
  const h = wire({ provider });
  h.bus.emit('friend.add_requested', { requestId: 'ext1', target: { phone: '13800000000' } });
  await settle();

  // findActiveByTargetKey 排除终态；failed 是终态，故查不到活跃任务
  assert.equal(h.store.findActiveByTargetKey('phone:13800000000'), undefined, 'is_svr_fail 判失败(终态)');
  assert.equal(h.firstTouch.length, 0);
  // 即便对方"通过"，因未登记 pendingConfirm，也不会误触发首触
  h.provider.simulatePeerAccept('acc1', 'wx_x');
  await settle();
  assert.equal(h.firstTouch.length, 0, '未登记确认的好友变化不误触首触');
});

test('E2E 被动: 收到申请 → 自动通过 → agree → 2131 实证 → 首触(passive)', async () => {
  const h = wire();
  h.provider.simulateFriendApply('acc1', 'req1', 'wx_peer', '你好');
  await settle();

  h.provider.simulatePeerAccept('acc1', 'wx_peer');
  await settle();

  assert.equal(h.firstTouch.length, 1, '被动通过也交棒首触');
  assert.equal(h.firstTouch[0]!.wxid, 'wx_peer');
  assert.equal(h.firstTouch[0]!.taskId, undefined, '被动无主动任务 taskId');
});

test('4.8c 轮询兜底：2131 漏报时，pollConfirms 仍能确认真通过 → 首触', async () => {
  const h = wire();
  h.bus.emit('friend.add_requested', { requestId: 'ext1', target: { phone: '13800000000' } });
  await settle();
  assert.equal(h.store.findActiveByTargetKey('phone:13800000000')!.state, 'pending');

  // 对方通过了，但 2131 没来（漏报）——不 fire 回调，只让好友"静默"进增量。
  h.provider.seedFriendSilently('acc1', 'wx_13800000000');
  assert.equal(h.firstTouch.length, 0, '没有 2131、没轮询前不会确认');

  // 巡视周期调用轮询兜底 → sync 确认 → friend.accepted
  await h.gateway.pollConfirms();
  await settle();
  assert.equal(h.firstTouch.length, 1, '轮询兜底确认真通过后交棒首触');
  assert.equal(h.firstTouch[0]!.wxid, 'wx_13800000000');
});

test('1.3 执行端：连续加友按账号串行 + 每次前置拟人间隔（叠抖动）', async () => {
  const bus = new EventBus<BrainEventMap>();
  const provider = new FakeProvider();
  const sleeps: number[] = [];
  const ops: string[] = [];
  bus.on('op.result', (e) => { ops.push(e.requestId); });
  // jitter 用恒等（把中心值原样返回）以断言「间隔被叠加」；抖动分布正确性在 kernel humanize.test 单测。
  const gateway = createGateway({
    bus,
    provider,
    pacing: { jitter: (c) => c, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } },
  });
  const mk = (n: string, phone: string) => ({
    type: 'friend.add' as const,
    payload: { accountId: 'a', taskId: n, requestId: n, target: { phone }, channel: 'phone' as const, preAddDelayMs: 90_000 },
  });
  gateway.port.send(mk('r1', '111'));
  gateway.port.send(mk('r2', '222'));
  await settle();
  assert.deepEqual(sleeps, [90_000, 90_000], '每次加友前叠一段间隔');
  assert.deepEqual(ops, ['r1', 'r2'], '同账号串行、按序发起');
});

test('4.7 多租户: acc1 通过不影响 acc2，事件不串号', async () => {
  const h = wire({ accountIds: ['acc1', 'acc2'] });
  h.bus.emit('friend.add_requested', { requestId: 'e1', target: { phone: '111' }, preferredAccountId: 'acc1' });
  h.bus.emit('friend.add_requested', { requestId: 'e2', target: { phone: '222' }, preferredAccountId: 'acc2' });
  await settle();

  const t1 = h.store.findActiveByTargetKey('phone:111')!;
  const t2 = h.store.findActiveByTargetKey('phone:222')!;
  assert.equal(t1.accountId, 'acc1');
  assert.equal(t2.accountId, 'acc2');
  assert.equal(t1.state, 'pending');
  assert.equal(t2.state, 'pending');

  // 只让 acc1 的目标通过
  h.provider.simulatePeerAccept('acc1', 'wx_111');
  await settle();

  assert.equal(h.firstTouch.length, 1, '只 acc1 交棒');
  assert.equal(h.firstTouch[0]!.accountId, 'acc1');
  assert.equal(h.store.get(t2.taskId)!.state, 'pending', 'acc2 任务不受影响');
});
