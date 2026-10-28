import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import plugin from '../lib/index.js';
import { DEFAULTS } from '../lib/config.js';
import { dateInZone } from '../lib/store.js';
import {
  FIXED_NOW, makeEnv, mockCtx, writeEventFile,
} from './helpers.js';

/** 版本号只从 package.json 取，升版时不用改测试 */
const PKG_VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

/** 插件内部用真实时钟；集成测试按同一时区算“今天”，不假设某个固定日期。 */
function realToday() {
  return dateInZone(new Date(), 'Asia/Shanghai');
}

function realDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function snapshotRealDsh() {
  const home = realDshHome();
  const names = [
    'whale-beliefs.md', 'whale-beliefs-log.jsonl', 'whale-undone.jsonl',
    'whale-rule-usage.json', 'whale-conflicts.jsonl',
  ];
  const bag = {};
  for (const name of names) {
    const file = path.join(home, name);
    try {
      const stat = fs.statSync(file);
      bag[name] = `${stat.size}:${stat.mtimeMs}`;
    } catch {
      bag[name] = 'missing';
    }
  }
  return bag;
}

test('S5/S21: apply() 注册 8 工具、1 个 guard、收工/后置监听、尾部注入段', () => {
  const env = makeEnv();
  const mock = mockCtx();
  try {
    plugin.apply(mock.ctx, env.config);
    assert.deepEqual(plugin.inject, ['tools']);
    assert.equal(mock.tools.size, 8);
    assert.equal(mock.guards.length, 1);
    assert.equal((mock.listeners.get('agent/turn-stopping') ?? []).length, 1);
    assert.equal((mock.listeners.get('tools/post-execute') ?? []).length, 1);
    assert.equal(mock.sections.length, 1);
    assert.equal(mock.sections[0].name, 'leno-ledger');
    assert.ok(mock.sections[0].order >= 9000);
    assert.equal(typeof mock.sections[0].text, 'function');
    assert.equal(mock.effects.length, 1);

    const state = JSON.parse(fs.readFileSync(path.join(env.dshHome, 'ledger-state.json'), 'utf8'));
    assert.equal(state.version, PKG_VERSION);
    assert.equal(typeof state.pid, 'number');
    assert.match(state.loadedAt, /^\d{4}-\d{2}-\d{2}T/);
    for (const name of ['tools', 'guard', 'injection', 'turnStopping', 'postExecute']) {
      assert.equal(state.segments[name]?.ok, true, `${name} 应该是 ok`);
    }
  } finally {
    env.cleanup();
  }
});

test('S21: 对已存在文件调用 write，先产生备份再放行，结果里带提示', async () => {
  const env = makeEnv();
  const mock = mockCtx();
  try {
    const file = path.join(env.dshHome, 'existing.md');
    fs.writeFileSync(file, '改前', 'utf8');
    plugin.apply(mock.ctx, env.config);

    const exec = { name: 'write', arguments: { file_path: file, content: '改后' } };
    const guard = mock.guards[0];
    assert.equal(guard(exec), undefined);

    const day = realToday();
    const backups = fs.readdirSync(path.join(env.store.backupRoot, day));
    assert.deepEqual(backups, ['existing.md.bak']);
    assert.equal(
      fs.readFileSync(path.join(env.store.backupRoot, day, 'existing.md.bak'), 'utf8'),
      '改前',
    );

    const post = (mock.listeners.get('tools/post-execute') ?? [])[0];
    const decision = await post(exec, { content: [{ type: 'text', text: 'ok' }] }, async () => ({ kind: 'accept' }));
    assert.ok(decision.content.some((block) => /已自动备份/.test(block.text)));

    const today = (await mock.tools.get('ledger_today').execute({})).text;
    assert.match(today.split('\n')[0], /^改1 备1 \|/);
  } finally {
    env.cleanup();
  }
});

test('v0.3/S1–S3: 缺 ctx.tools 时其余段仍注册，state 与 load 错误落盘', () => {
  const env = makeEnv();
  const mock = mockCtx({ withTools: false });
  try {
    plugin.apply(mock.ctx, env.config);
    assert.equal(mock.tools.size, 0);
    assert.equal(mock.guards.length, 0);
    assert.equal(mock.sections.length, 1, '注入段不应被 tools 失败带倒');
    assert.equal((mock.listeners.get('agent/turn-stopping') ?? []).length, 1);
    assert.equal((mock.listeners.get('tools/post-execute') ?? []).length, 1);

    const state = JSON.parse(fs.readFileSync(path.join(env.dshHome, 'ledger-state.json'), 'utf8'));
    assert.equal(state.segments.tools.ok, false);
    assert.match(state.segments.tools.error, /ctx\.tools/);
    assert.equal(state.segments.guard.ok, false);
    assert.equal(state.segments.injection.ok, true);
    assert.equal(state.segments.turnStopping.ok, true);
    assert.equal(state.segments.postExecute.ok, true);

    const errors = fs.readFileSync(path.join(env.dshHome, 'ledger-errors.jsonl'), 'utf8')
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(errors.some((row) => row.type === 'load' && row.segment === 'tools'));
    assert.ok(errors.some((row) => row.type === 'load' && row.segment === 'guard'));
  } finally {
    env.cleanup();
  }
});

test('v0.3/S1: systemPrompt 不可用时只有 injection 段失败，其余照常', () => {
  const env = makeEnv();
  const mock = mockCtx({ withSystemPrompt: false });
  try {
    plugin.apply(mock.ctx, env.config);
    assert.equal(mock.tools.size, 8);
    assert.equal(mock.guards.length, 1);
    assert.equal(mock.sections.length, 0);
    assert.equal((mock.listeners.get('agent/turn-stopping') ?? []).length, 1);
    const state = JSON.parse(fs.readFileSync(path.join(env.dshHome, 'ledger-state.json'), 'utf8'));
    assert.equal(state.segments.injection.ok, false);
    assert.match(state.segments.injection.error, /systemPrompt/);
    assert.equal(state.segments.tools.ok, true);
    assert.equal(state.segments.turnStopping.ok, true);
  } finally {
    env.cleanup();
  }
});

test('v0.3/S10: 无账时 turn-stopping 触发 steer；记一笔 change 后放行', () => {
  const env = makeEnv({ config: { minIntervalMs: 0 } });
  const mock = mockCtx();
  try {
    plugin.apply(mock.ctx, env.config);
    const listener = (mock.listeners.get('agent/turn-stopping') ?? [])[0];

    const agent = { steers: [], steer(message) { this.steers.push(message); } };
    listener({ agent, turn: 1 });
    assert.equal(agent.steers.length, 1);
    assert.match(agent.steers[0].content[0].text, /leno-ledger: 收工未记账/);

    env.store.appendManifest({
      // 插件内部用真实时钟，这里必须写“真实的今天”，不能写固定时钟的 10-26。
      t: new Date().toISOString(),
      path: path.join(env.root, 'worked.md'), kind: 'change', sha256: 'x', size: 1, mtime: '',
    });
    listener({ agent, turn: 2 });
    assert.equal(agent.steers.length, 1, '今天有账后不再敲');
  } finally {
    env.cleanup();
  }
});

test('S17/S19: 注入段正常时为空，有未做时 ≤5 行且标 24h', async () => {
  const env = makeEnv();
  const mock = mockCtx();
  try {
    plugin.apply(mock.ctx, env.config);
    const section = mock.sections[0];
    const today = realToday();
    writeEventFile(env, today);

    assert.equal(section.text({ scope: 'test' }), '');

    await mock.tools.get('ledger_undone').execute({ text: '没打开「发一条之前」' });
    const first = section.text({ scope: 'test' });
    assert.ok(first.length > 0);
    assert.ok(first.split('\n').length <= 5);
    assert.match(first, /未做：没打开/);

    const second = section.text({ scope: 'test' });
    assert.ok(!second.includes('没打开「发一条之前」'));
    assert.ok(second.split('\n').length <= 5);

    writeEventFile(env, today);
    const third = section.text({ scope: 'test' });
    assert.ok(third.split('\n').length <= 5);
  } finally {
    env.cleanup();
  }
});

test('S19: 无未做、今日有事件、错误 <3 时注入空段', async () => {
  const env = makeEnv();
  const mock = mockCtx();
  try {
    plugin.apply(mock.ctx, env.config);
    writeEventFile(env, realToday());
    assert.equal(mock.sections[0].text({ scope: 'test' }), '');
  } finally {
    env.cleanup();
  }
});

test('S25: dispose 后工具/guard/监听/注入段全部撤销', async () => {
  const env = makeEnv();
  const mock = mockCtx();
  try {
    plugin.apply(mock.ctx, env.config);
    assert.equal(mock.tools.size, 8);
    mock.dispose();
    assert.equal(mock.tools.size, 0);
    assert.equal(mock.guards.length, 0);
    assert.equal(mock.sections.length, 0);
    assert.equal((mock.listeners.get('agent/turn-stopping') ?? []).length, 0);
    assert.equal((mock.listeners.get('tools/post-execute') ?? []).length, 0);
  } finally {
    env.cleanup();
  }
});

test('S22: 跑完整流程前后，真实 ~/.dsh 关键文件 size+mtime 不变', async () => {
  const before = snapshotRealDsh();
  const env = makeEnv();
  const mock = mockCtx();
  try {
    plugin.apply(mock.ctx, env.config);
    const file = path.join(env.dshHome, 'isolated.md');
    fs.writeFileSync(file, 'x', 'utf8');
    mock.guards[0]({ name: 'write', arguments: { file_path: file, content: 'y' } });
    await mock.tools.get('ledger_today').execute({});
    await mock.tools.get('ledger_error').execute({ text: '测试错误' });
  } finally {
    env.cleanup();
  }
  assert.deepEqual(snapshotRealDsh(), before);
});

test('S2: 启用后六类数据文件可发现，且不截断已有内容', async () => {
  const env = makeEnv();
  const mock = mockCtx();
  try {
    const existing = '{"t":"2026-10-25T00:00:00.000Z","topic":"旧"}\n';
    fs.writeFileSync(env.store.conflictsFile, existing, 'utf8');
    plugin.apply(mock.ctx, env.config);

    for (const file of [
      env.store.conflictsFile, env.store.manifestFile,
      env.store.errorFile, env.store.criteriaLogFile, env.store.ruleUsageFile,
    ]) {
      assert.ok(fs.existsSync(file), `missing ${file}`);
    }
    assert.ok(fs.statSync(env.store.criteriaDir).isDirectory());
    assert.equal(fs.readFileSync(env.store.conflictsFile, 'utf8'), existing);
    assert.deepEqual(JSON.parse(fs.readFileSync(env.store.ruleUsageFile, 'utf8')), {});

    await mock.tools.get('ledger_belief').execute({
      action: 'add', id: 'A9', title: '新规矩', body: '正文',
    });
    assert.ok(fs.existsSync(env.store.criteriaFile('A9')));
  } finally {
    env.cleanup();
  }
});

test('配置缺省值：默认只备份+记账，任何个人目录都不写死', () => {
  // v0.3：默认不再指向任何人的工作区；不给 workspaceRoot/sayDir/rulesDir 就没有收工闸
  assert.equal(DEFAULTS.workspaceRoot, '');
  assert.equal(DEFAULTS.sayDir, '');
  assert.equal(DEFAULTS.rulesDir, '');
  assert.equal(DEFAULTS.autoBackup, true);
  assert.equal(DEFAULTS.maxSkipsPerDay, 3);
  assert.equal(DEFAULTS.timeZone, null);
  assert.equal(DEFAULTS.inject, true);
  assert.ok(DEFAULTS.dshHome.endsWith('.dsh'));
  assert.ok(DEFAULTS.ignore.includes('node_modules'));
});

test('固定时钟辅助函数本身可用（防止测试基线漂移）', () => {
  assert.equal(FIXED_NOW().toISOString(), '2026-10-26T10:00:00.000Z');
});
