import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EventBus, RiskController } from '@aiim/kernel';
import { WECHAT_RISK_POLICY, type WechatRiskAction } from '@aiim/contracts';
import { InMemoryFriendAddStore } from '@aiim/store';
import { createFriendAddLoop } from '../src/friend-add/coordinator';
import type { AccountRuntime, BrainEventMap, FriendAddConfig, OutboundCommand } from '../src/friend-add/types';

const CONFIG: FriendAddConfig = {
  pendingTimeoutMs: 1000,
  maxConsecutiveFailures: 2,
  preAddDelayBaseMs: 90_000,
  trustDays: 7,
  suspiciousKeywords: ['广告'],
};

/** 冲刷 onAuthorized 里 record 的微任务（异步链），让 gateway.send 完成后再断言。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function makeHarness(opts: { seedFriends?: string[]; seedBlacklist?: string[]; quotaLevel?: 'conservative' | 'normal' | 'aggressive' } = {}) {
  const clockRef = { t: 1_000_000_000_000 };
  const clock = () => clockRef.t;
  const bus = new EventBus<BrainEventMap>();
  const store = new InMemoryFriendAddStore({ friends: opts.seedFriends, blacklist: opts.seedBlacklist });
  const sent: OutboundCommand[] = [];
  const gateway = { send: (c: OutboundCommand) => sent.push(c) };
  const account: AccountRuntime = {
    accountId: 'acc1',
    risk: new RiskController<WechatRiskAction>({ policy: WECHAT_RISK_POLICY, accountId: 'acc1', quotaLevel: opts.quotaLevel ?? 'aggressive', clock }),
  };
  const firstTouch: BrainEventMap['first_touch.needed'][] = [];
  const alerts: BrainEventMap['alert'][] = [];
  const rejected: BrainEventMap['friend.add.rejected'][] = [];
  const deferred: BrainEventMap['friend.add.deferred'][] = [];
  bus.on('first_touch.needed', (e) => { firstTouch.push(e); });
  bus.on('alert', (e) => { alerts.push(e); });
  bus.on('friend.add.rejected', (e) => { rejected.push(e); });
  bus.on('friend.add.deferred', (e) => { deferred.push(e); });
  const loop = createFriendAddLoop({ bus, gateway, store, accounts: () => [account], config: CONFIG, clock });
  return { bus, store, sent, account, firstTouch, alerts, rejected, deferred, loop, clock, clockRef };
}

function addOf(sent: OutboundCommand[]) {
  return sent.filter((c) => c.type === 'friend.add');
}

test('AC-ADD: op.result ok 只进 pending，绝不判成功、绝不触发首触', async () => {
  const h = makeHarness();
  h.bus.emit('friend.add_requested', { requestId: 'r1', target: { phone: '13800000000' } });
  await settle();
  const adds = addOf(h.sent);
  assert.equal(adds.length, 1, '应下发一次 friend.add');
  const cmd = adds[0]!.payload;
  assert.ok(cmd.requestId, '命令带 requestId 供关联');
  assert.ok((cmd.preAddDelayMs ?? 0) > 0, '带非零加友拟人间隔');

  h.bus.emit('op.result', { accountId: 'acc1', command: 'friend.add', requestId: cmd.requestId, ok: true, isSvrFail: false });
  const task = h.store.findByRequestId(cmd.requestId)!;
  assert.equal(task.state, 'pending', '回执 ok 只进 pending');
  assert.equal(h.firstTouch.length, 0, '绝不因回执 ok 触发首触');
});

test('AC-ADD: 只有 friend.accepted（实证）才判 accepted 并交棒首触', async () => {
  const h = makeHarness();
  h.bus.emit('friend.add_requested', { requestId: 'r1', target: { phone: '13800000000' } });
  await settle();
  const cmd = addOf(h.sent)[0]!.payload;
  h.bus.emit('op.result', { accountId: 'acc1', command: 'friend.add', requestId: cmd.requestId, ok: true });

  h.bus.emit('friend.accepted', { accountId: 'acc1', taskId: cmd.taskId, wxid: '788x', conversationId: 'S:788x', via: 'active' });
  const task = h.store.get(cmd.taskId)!;
  assert.equal(task.state, 'accepted');
  assert.equal(h.firstTouch.length, 1, '实证通过后交棒一次首触');
  assert.equal(h.firstTouch[0]!.wxid, '788x');
});

test('AC-ADD: 无目标身份受理即拒、不下发', async () => {
  const h = makeHarness();
  h.bus.emit('friend.add_requested', { requestId: 'r1', target: {} });
  await settle();
  assert.equal(addOf(h.sent).length, 0);
  assert.equal(h.rejected.length, 1);
  assert.equal(h.rejected[0]!.reason, 'no_target');
});

test('AC-ADD: 同一目标重复指令幂等（只一个任务、只下发一次）', async () => {
  const h = makeHarness();
  h.bus.emit('friend.add_requested', { requestId: 'r1', target: { phone: '13800000000' } });
  await settle();
  h.bus.emit('friend.add_requested', { requestId: 'r2', target: { phone: '13800000000' } });
  await settle();
  assert.equal(addOf(h.sent).length, 1, '重复指令不再下发');
});

test('AC-ADD: pending 超时判失败、不触发首触', async () => {
  const h = makeHarness();
  h.bus.emit('friend.add_requested', { requestId: 'r1', target: { phone: '13800000000' } });
  await settle();
  const cmd = addOf(h.sent)[0]!.payload;
  h.bus.emit('op.result', { accountId: 'acc1', command: 'friend.add', requestId: cmd.requestId, ok: true });
  assert.equal(h.store.get(cmd.taskId)!.state, 'pending');

  h.loop.sweepTimeouts(h.clock() + CONFIG.pendingTimeoutMs + 1);
  assert.equal(h.store.get(cmd.taskId)!.state, 'failed');
  assert.equal(h.store.get(cmd.taskId)!.failReason, 'timeout');
  assert.equal(h.firstTouch.length, 0);
});

test('撞加友配额（无可用号）→ deferred，绝不自升风控状态', async () => {
  const h = makeHarness({ quotaLevel: 'aggressive' });
  // aggressive add_friend 小时 burst=5：先把小时窗打满。
  for (let i = 0; i < 5; i++) {
    assert.equal(await h.account.risk.record('add_friend'), true);
    h.clockRef.t += 61_000; // 跨分钟窗、逼近小时窗
  }
  assert.equal(h.account.risk.canDo('add_friend'), false);

  h.bus.emit('friend.add_requested', { requestId: 'r1', target: { phone: '13800000000' } });
  await settle();
  assert.equal(addOf(h.sent).length, 0, '撞配额不下发');
  assert.equal(h.deferred.length, 1);
  assert.equal(h.account.risk.getState().status, 'normal', '撞配额绝不自升风控状态');
});

test('被动加友：非可疑自动通过（下发 friend.accept），accepted 后交棒首触', async () => {
  const h = makeHarness();
  h.bus.emit('friend.request_received', { accountId: 'acc1', requestId: 'req1', fromWxid: '788y', verifyText: '你好' });
  await settle();
  const accepts = h.sent.filter((c) => c.type === 'friend.accept');
  assert.equal(accepts.length, 1, '自动通过下发 friend.accept');

  h.bus.emit('friend.accepted', { accountId: 'acc1', wxid: '788y', conversationId: 'S:788y', via: 'passive' });
  assert.equal(h.firstTouch.length, 1, '被动通过也交棒首触');
});

test('被动加友：可疑申请挂人审、不自动通过', async () => {
  const h = makeHarness();
  h.bus.emit('friend.request_received', { accountId: 'acc1', requestId: 'req1', fromWxid: '788z', verifyText: '我发广告的' });
  await settle();
  assert.equal(h.sent.filter((c) => c.type === 'friend.accept').length, 0, '可疑不自动通过');
  assert.equal(h.alerts.length, 1);
  assert.equal(h.alerts[0]!.kind, 'friend_request_manual_review');
});

test('连续加友失败到顶 → 升级停手（告警 + 置风控态），协调器不自动重发', async () => {
  const h = makeHarness();
  for (let i = 0; i < CONFIG.maxConsecutiveFailures; i++) {
    h.bus.emit('friend.add_requested', { requestId: `r${i}`, target: { phone: `1380000000${i}` } });
    await settle();
    const adds = addOf(h.sent);
    assert.equal(adds.length, i + 1, '每轮都应真正发起（拉开间隔避开 minute burst）');
    const cmd = adds[adds.length - 1]!.payload;
    h.bus.emit('op.result', { accountId: 'acc1', command: 'friend.add', requestId: cmd.requestId, ok: false, isSvrFail: true });
    h.clockRef.t += 61_000; // 加友间隔 ≥1 分钟：避开 add_friend 的 minute burst，下一次才能真正发起
  }
  await settle();
  assert.equal(h.alerts.filter((a) => a.kind === 'friend_add_systemic_failure').length, 1, '到顶升级告警一次');
  assert.notEqual(h.account.risk.getState().status, 'normal', '系统性失败诚实置风控态');
});
