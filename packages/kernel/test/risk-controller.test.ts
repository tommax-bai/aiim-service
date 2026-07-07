import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RiskController } from '../src/risk/risk-controller';
import type { RiskPolicy } from '../src/risk/types';

// 一份最小的微信风格策略（测试自带，验证泛型化 + 参数化替换掉 XHS 硬编码后红线仍成立）。
type Act = 'add_friend' | 'accept_friend' | 'send_message' | 'read_message';

const POLICY: RiskPolicy<Act> = {
  actions: ['add_friend', 'accept_friend', 'send_message', 'read_message'],
  quotas: {
    conservative: { add_friend: 5, accept_friend: 10, send_message: 200, read_message: 100_000 },
    normal: { add_friend: 15, accept_friend: 30, send_message: 500, read_message: 100_000 },
    aggressive: { add_friend: 30, accept_friend: 60, send_message: 1000, read_message: 100_000 },
  },
  minuteBurstCap: { add_friend: 2, accept_friend: 3, send_message: 20, read_message: 100_000 },
  hourBurstCap: { add_friend: 5, accept_friend: 8, send_message: 100, read_message: 100_000 },
  restrictedAllowedActions: ['read_message', 'send_message'], // 仅被动接待
  warnedPausedActions: ['add_friend'], // warned 暂停主动加友
};

function fixedClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000_000_000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('AC-RISK: 撞加友日配额只背压、record 返 false，绝不自升风控状态', async () => {
  const clock = fixedClock();
  const rc = new RiskController<Act>({ policy: POLICY, quotaLevel: 'aggressive', clock: clock.now });
  // aggressive: add_friend 日配额 30，但分钟 burst=2、小时 burst=5 —— 先打满小时窗。
  let ok = 0;
  for (let i = 0; i < 5; i++) {
    if (await rc.record('add_friend')) ok++;
    clock.advance(61_000); // 跨过分钟窗，避开 minute burst，逼近 hour burst
  }
  assert.equal(ok, 5, 'hour burst=5 应放行 5 次');
  assert.equal(await rc.record('add_friend'), false, '第 6 次撞小时配额应背压返 false');
  assert.equal(rc.canDo('add_friend'), false);
  assert.equal(rc.getState().status, 'normal', '撞自己配额绝不自升状态');
  assert.equal(rc.getState().signalCount, 0, '配额背压不产生风控信号');
});

test('AC-RISK: frozen 账号任何 record 返 false', async () => {
  const rc = new RiskController<Act>({ policy: POLICY });
  await rc.applySignal({ kind: 'fatal' });
  assert.equal(rc.getState().status, 'frozen');
  assert.equal(await rc.record('read_message'), false);
  assert.equal(await rc.record('add_friend'), false);
});

test('风控状态机：light 逐级升 normal→warned→restricted，confirmed 直达 restricted，fatal→frozen', async () => {
  const a = new RiskController<Act>({ policy: POLICY });
  await a.applySignal({ kind: 'light' });
  assert.equal(a.getState().status, 'warned');
  await a.applySignal({ kind: 'light' });
  assert.equal(a.getState().status, 'restricted');

  const b = new RiskController<Act>({ policy: POLICY });
  await b.applySignal({ kind: 'confirmed' });
  assert.equal(b.getState().status, 'restricted');

  const c = new RiskController<Act>({ policy: POLICY });
  await c.applySignal({ kind: 'fatal' });
  assert.equal(c.getState().status, 'frozen');
});

test('restricted 只放行被动动作（read/send），停一切主动加友', async () => {
  const rc = new RiskController<Act>({ policy: POLICY });
  await rc.applySignal({ kind: 'confirmed' }); // → restricted
  assert.equal(rc.canDo('read_message'), true);
  assert.equal(rc.canDo('send_message'), true);
  assert.equal(rc.explain('add_friend').reason, 'state:restricted');
  assert.equal(rc.canDo('add_friend'), false);
});

test('warned 暂停主动加友、其余照常', async () => {
  const rc = new RiskController<Act>({ policy: POLICY });
  await rc.applySignal({ kind: 'light' }); // → warned
  assert.equal(rc.explain('add_friend').reason, 'state:warned_paused');
  assert.equal(rc.canDo('accept_friend'), true);
  assert.equal(rc.canDo('send_message'), true);
});

test('ratioGuard 注入生效（占位：加友通过率护栏可插拔）', async () => {
  const policyWithGuard: RiskPolicy<Act> = {
    ...POLICY,
    ratioGuard: (action) => action !== 'add_friend', // 强制拒绝加友，验证护栏被调用
  };
  const rc = new RiskController<Act>({ policy: policyWithGuard });
  assert.equal(rc.explain('add_friend').reason, 'ratio');
  assert.equal(rc.canDo('accept_friend'), true);
});
