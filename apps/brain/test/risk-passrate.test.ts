/**
 * 加友通过率护栏（friend-add-closed-loop 4.8）：把闭环结果反馈回风控——
 * 近窗已决加友里通过率过低 → 停加友背压（非风控信号，只 canDo 拒）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RiskController } from '@aiim/kernel';
import { ADD_PASS_MIN_SAMPLES, WECHAT_RISK_POLICY, type WechatRiskAction } from '@aiim/contracts';

const clock = () => 1_700_000_000_000;
const mk = () => new RiskController<WechatRiskAction>({ policy: WECHAT_RISK_POLICY, quotaLevel: 'aggressive', clock });

test('通过率护栏：已决样本不足 → 放行', async () => {
  const r = mk();
  for (let i = 0; i < 3; i++) await r.note('add_friend_rejected');
  assert.equal(r.canDo('add_friend'), true, `已决 <${ADD_PASS_MIN_SAMPLES} 放行`);
});

test('通过率护栏：样本足且通过率过低 → 停加友(reason ratio)，不影响其它动作', async () => {
  const r = mk();
  for (let i = 0; i < ADD_PASS_MIN_SAMPLES; i++) await r.note('add_friend_rejected');
  assert.equal(r.explain('add_friend').reason, 'ratio');
  assert.equal(r.canDo('add_friend'), false);
  assert.equal(r.canDo('accept_friend'), true, '被动接待不受加友通过率护栏影响');
  assert.equal(r.getState().status, 'normal', '通过率护栏只背压、不自升状态');
});

test('通过率护栏：通过率回升到阈值以上 → 放行', async () => {
  const r = mk();
  for (let i = 0; i < 10; i++) await r.note('add_friend_rejected');
  for (let i = 0; i < 5; i++) await r.note('add_friend_accepted'); // 5/15 ≈ 0.33 ≥ 0.3
  assert.equal(r.canDo('add_friend'), true);
});

test('note() 不经 canDo 门控：frozen 账号仍记录结果计数', async () => {
  const r = mk();
  await r.applySignal({ kind: 'fatal' }); // frozen
  await r.note('add_friend_accepted');
  assert.equal(r.counts().day.add_friend_accepted, 1, 'note 绕过 canDo，frozen 也记');
});
