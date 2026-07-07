/**
 * 分层依赖边界检查（friend-add-closed-loop 1.4）。零依赖、纯 node，符合「轻量优先、不引重型框架」。
 * 把「kernel 是领域无关基座、不反向依赖任何 @aiim/* 域包」等 DAG 约定变成 CI 强制，
 * 防微信契约（WechatEventMap/MessageType 等）漏进通用引擎——AIDCP 的 EventBus 就栽在这上面。
 *
 * 用法：node scripts/check-boundaries.mjs  （违规退出码 1）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/** 每条规则：某目录下的源码禁止 import 命中 forbid(spec) 的模块。 */
const RULES = [
  {
    name: 'kernel',
    dir: 'packages/kernel/src',
    why: 'kernel 是领域无关基座：禁止反向依赖 @aiim/* 域包或 apps/*（防微信契约漏进通用引擎）',
    forbid: (spec) =>
      spec.startsWith('@aiim/') ||
      (spec.startsWith('.') && /(^|\/)(apps|contracts|store|brain|gateway)\//.test(spec)),
  },
  {
    name: 'contracts',
    dir: 'packages/contracts/src',
    why: 'contracts 只可依赖 @aiim/kernel，不可反向依赖 store/brain/gateway 或 apps',
    forbid: (spec) =>
      /^@aiim\/(store|brain|gateway)/.test(spec) ||
      (spec.startsWith('.') && /(^|\/)(apps|store|brain|gateway)\//.test(spec)),
  },
];

/** 从一行代码里抽出被 import 的模块字符串（import/export ... from '…'、side-effect import、require、动态 import）。 */
function extractSpecifiers(line) {
  const specs = [];
  const patterns = [
    /(?:import|export)\b[^'"]*\bfrom\s*['"]([^'"]+)['"]/,
    /\bimport\s*['"]([^'"]+)['"]/, // side-effect import
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/, // dynamic import
  ];
  for (const re of patterns) {
    const m = line.match(re);
    if (m) specs.push(m[1]);
  }
  return specs;
}

function walkTs(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkTs(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const violations = [];
for (const rule of RULES) {
  const dir = join(ROOT, rule.dir);
  for (const file of walkTs(dir)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const spec of extractSpecifiers(line)) {
        if (rule.forbid(spec)) {
          violations.push({ rule: rule.name, why: rule.why, file: relative(ROOT, file), line: i + 1, spec });
        }
      }
    });
  }
}

if (violations.length > 0) {
  console.error(`✖ 分层边界违规 ${violations.length} 处：\n`);
  for (const v of violations) {
    console.error(`  [${v.rule}] ${v.file}:${v.line} → import '${v.spec}'`);
    console.error(`     ${v.why}\n`);
  }
  process.exit(1);
}
console.log('✔ 分层边界检查通过（kernel/contracts 单向依赖，无反向泄漏）');
