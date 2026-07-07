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
  const gateway = createGateway({ bus, provider });
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
