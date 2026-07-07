/**
 * 选号打分（friend-add-closed-loop 4.8b）：号龄（养号期降权）+ 垂类匹配 + 剩余配额负载均衡。
 * 用外部指令走完 intake→选号，断言任务落到"应选"的账号。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EventBus, RiskController } from '@aiim/kernel';
import { WECHAT_RISK_POLICY, type WechatRiskAction } from '@aiim/contracts';
import { InMemoryFriendAddStore } from '@aiim/store';
import { createFriendAddLoop } from '../src/friend-add/coordinator';
import { DEFAULT_FRIEND_ADD_CONFIG, type AccountRuntime, type BrainEventMap, type GatewayPort } from '../src/friend-add/types';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60_000;
const clock = () => NOW;

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function acct(accountId: string, extra: Partial<AccountRuntime> = {}): AccountRuntime {
  return {
    accountId,
    risk: new RiskController<WechatRiskAction>({ policy: WECHAT_RISK_POLICY, accountId, quotaLevel: 'aggressive', clock }),
    ...extra,
  };
}

function wire(accounts: AccountRuntime[]) {
  const bus = new EventBus<BrainEventMap>();
  const store = new InMemoryFriendAddStore();
  const sent: string[] = [];
  const gateway: GatewayPort = { send: (c) => { sent.push(c.payload.accountId); } };
  const loop = createFriendAddLoop({ bus, gateway, store, accounts: () => accounts, config: DEFAULT_FRIEND_ADD_CONFIG, clock });
  return { bus, store, sent, loop };
}

test('4.8b 选号：号龄优先（养号期新号降权，选老号）', async () => {
  const fresh = acct('fresh', { createdAt: NOW - 1 * DAY }); // 1 天，养号期内
  const mature = acct('mature', { createdAt: NOW - 30 * DAY }); // 30 天，已过养号期
  const h = wire([fresh, mature]); // 故意把新号放前面，证明不是"取第一个"
  h.bus.emit('friend.add_requested', { requestId: 'r1', target: { phone: '111' } });
  await settle();
  assert.deepEqual(h.sent, ['mature'], '号龄高的老号优先承接');
});

test('4.8b 选号：垂类匹配优先', async () => {
  const edu = acct('edu', { createdAt: NOW - 30 * DAY, verticals: ['edu', 'k12'] });
  const fin = acct('fin', { createdAt: NOW - 30 * DAY, verticals: ['finance'] });
  const h = wire([fin, edu]);
  h.bus.emit('friend.add_requested', { requestId: 'r1', target: { phone: '111' }, vertical: 'edu' });
  await settle();
  assert.deepEqual(h.sent, ['edu'], '垂类匹配的账号优先');
});

test('4.8b 选号：显式指定承接账号（可用则尊重，压过打分）', async () => {
  const mature = acct('mature', { createdAt: NOW - 30 * DAY });
  const fresh = acct('fresh', { createdAt: NOW - 1 * DAY });
  const h = wire([mature, fresh]);
  h.bus.emit('friend.add_requested', { requestId: 'r1', target: { phone: '111' }, preferredAccountId: 'fresh' });
  await settle();
  assert.deepEqual(h.sent, ['fresh'], '显式指定优先于打分');
});

test('4.8b 选号：无 createdAt 向后兼容（视为已过养号期、不降权）', async () => {
  const a = acct('a'); // 无 createdAt
  const b = acct('b'); // 无 createdAt
  const h = wire([a, b]);
  h.bus.emit('friend.add_requested', { requestId: 'r1', target: { phone: '111' } });
  await settle();
  assert.equal(h.sent.length, 1, '仍能选出账号（不因缺号龄而全被降权卡住）');
});
