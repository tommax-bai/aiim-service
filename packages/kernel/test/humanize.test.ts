import assert from 'node:assert/strict';
import { test } from 'node:test';

import { jitterAround } from '../src/humanize/timing';

/** 确定性 rng（mulberry32，分布好、无相邻相关），让断言不 flaky。 */
function lcg(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('jitterAround：恒正、有下限/上限、中心值≤0 归零', () => {
  const rng = lcg(42);
  for (let i = 0; i < 1000; i++) {
    const v = jitterAround(90_000, { rng, min: 1000, max: 600_000 });
    assert.ok(v >= 1000 && v <= 600_000, `落在 [min,max]：${v}`);
  }
  assert.equal(jitterAround(0), 0);
  assert.equal(jitterAround(-5), 0);
});

test('jitterAround：median ≈ 中心值（乘性 lognormal，无系统性偏移）', () => {
  const rng = lcg(7);
  const center = 90_000;
  const samples: number[] = [];
  for (let i = 0; i < 4000; i++) samples.push(jitterAround(center, { rng }));
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)]!;
  const ratio = median / center;
  assert.ok(ratio > 0.9 && ratio < 1.1, `median/center 应≈1，实测 ${ratio.toFixed(3)}`);
});

test('jitterAround：有真实离散（不是常数）', () => {
  const rng = lcg(123);
  const set = new Set<number>();
  for (let i = 0; i < 50; i++) set.add(jitterAround(90_000, { rng }));
  assert.ok(set.size > 15, `应有真实离散抖动（非常数），实测 ${set.size} 个不同值`);
});
