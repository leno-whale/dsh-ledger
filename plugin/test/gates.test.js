import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createBackupGuard, createPostExecute, createTurnStopper } from '../lib/gates.js';
import { makeEnv } from './helpers.js';

function execFor(name, args) {
  return { name, arguments: args };
}

test('S11/S21: autoBackup=true 时先备份再放行，并通过 post-execute 提示已备份', async () => {
  const env = makeEnv();
  try {
    const file = path.join(env.dshHome, 'gate.md');
    fs.writeFileSync(file, '旧内容', 'utf8');
    const notes = new WeakMap();
    const guard = createBackupGuard({ store: env.store, config: env.config, notes });
    const exec = execFor('write', { file_path: file, content: '新内容' });

    assert.equal(guard(exec), undefined);
    assert.equal(env.store.manifestRows().filter((r) => r.kind === 'backup').length, 1);
    const backup = env.store.manifestRows().find((r) => r.kind === 'backup');
    assert.equal(fs.readFileSync(backup.backup, 'utf8'), '旧内容');
    const change = env.store.manifestRows().find((r) => r.kind === 'change');
    assert.equal(change.path, file);
    assert.equal(change.source, 'gate');
    assert.equal(change.backup, backup.backup);

    const post = createPostExecute(notes);
    const decision = await post(exec, { content: [{ type: 'text', text: 'written' }] }, async () => ({ kind: 'accept' }));
    assert.equal(decision.kind, 'accept');
    assert.equal(decision.content.length, 2);
    assert.match(decision.content[1].text, /leno-ledger: 已自动备份/);
    assert.ok(decision.content[1].text.includes(backup.backup));
  } finally {
    env.cleanup();
  }
});

test('S10/S11: autoBackup=false 时硬拒绝，理由含关键字、绝对路径与可复制的补救调用', () => {
  const env = makeEnv({ config: { autoBackup: false } });
  try {
    const file = path.join(env.dshHome, 'blocked.md');
    fs.writeFileSync(file, '需要备份', 'utf8');
    const guard = createBackupGuard({ store: env.store, config: env.config, notes: new WeakMap() });

    const reason = guard(execFor('edit', {
      file_path: file, old_string: 'a', new_string: 'b',
    }));
    assert.equal(typeof reason, 'string');
    assert.ok(reason.includes('leno-ledger: 未备份'));
    assert.ok(reason.includes(file));
    assert.ok(reason.includes('ledger_backup'));
    assert.ok(reason.includes('"file_path"'));
    assert.equal(env.store.manifestRows().filter((r) => r.kind === 'backup').length, 0);
  } finally {
    env.cleanup();
  }
});

test('S12: 目标不存在时放行并记 kind:create', () => {
  const env = makeEnv({ config: { autoBackup: false } });
  try {
    const file = path.join(env.dshHome, 'new.md');
    const guard = createBackupGuard({ store: env.store, config: env.config, notes: new WeakMap() });
    assert.equal(guard(execFor('write', { file_path: file, content: 'x' })), undefined);
    const rows = env.store.manifestRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'create');
    assert.equal(rows[0].path, file);
  } finally {
    env.cleanup();
  }
});

test('S10: 已存在但 size=0 的文件视为新建，放行且不备份', () => {
  const env = makeEnv({ config: { autoBackup: false } });
  try {
    const file = path.join(env.dshHome, 'empty.md');
    fs.writeFileSync(file, '', 'utf8');
    const guard = createBackupGuard({ store: env.store, config: env.config, notes: new WeakMap() });
    assert.equal(guard(execFor('write', { file_path: file, content: 'x' })), undefined);
    assert.equal(env.store.manifestRows().filter((r) => r.kind === 'backup').length, 0);
  } finally {
    env.cleanup();
  }
});

test('S10/六问4: 当日已有同 sha256 备份时放行，且不再产生第二份备份', () => {
  const env = makeEnv({ config: { autoBackup: false } });
  try {
    const file = path.join(env.dshHome, 'already.md');
    fs.writeFileSync(file, '内容', 'utf8');
    env.store.backupFile(file);

    const guard = createBackupGuard({ store: env.store, config: env.config, notes: new WeakMap() });
    assert.equal(guard(execFor('write', { file_path: file, content: '新' })), undefined);
    assert.equal(env.store.manifestRows().filter((r) => r.kind === 'backup').length, 1);
  } finally {
    env.cleanup();
  }
});

test('S10: 只拦 write/edit；其他工具放行', () => {
  const env = makeEnv({ config: { autoBackup: false } });
  try {
    const file = path.join(env.dshHome, 'other.md');
    fs.writeFileSync(file, 'x', 'utf8');
    const guard = createBackupGuard({ store: env.store, config: env.config, notes: new WeakMap() });
    assert.equal(guard(execFor('read', { file_path: file })), undefined);
    assert.equal(guard(execFor('bash', { command: 'echo' })), undefined);
  } finally {
    env.cleanup();
  }
});

test('S15: 闸门内部异常一律放行并写错误账', () => {
  const env = makeEnv();
  try {
    const guard = createBackupGuard({ store: env.store, config: env.config, notes: new WeakMap() });
    const exec = { name: 'write' };
    Object.defineProperty(exec, 'arguments', {
      get() { throw new Error('boom-arguments'); },
    });
    assert.equal(guard(exec), undefined);
    const errors = env.store.errorRows();
    assert.equal(errors.length, 1);
    assert.match(errors[0].text, /boom-arguments/);
    assert.equal(errors[0].source, 'backup-gate');
  } finally {
    env.cleanup();
  }
});

test('v0.3/S10: 今天账空时 steer 取消收工，同一 turn 只敲一次', () => {
  const env = makeEnv({ config: { minIntervalMs: 0 } });
  try {
    const stopper = createTurnStopper({ store: env.store, config: env.config });
    const agent = { steers: [], steer(message) { this.steers.push(message); } };

    stopper({ agent, turn: 1 });
    assert.equal(agent.steers.length, 1);
    const text = agent.steers[0].content[0].text;
    assert.match(text, /^leno-ledger: 收工未记账/);
    assert.ok(text.includes('ledger_error'));
    assert.equal(agent.steers[0].role, 'user');

    stopper({ agent, turn: 1 });
    assert.equal(agent.steers.length, 1);

    stopper({ agent, turn: 2 });
    assert.equal(agent.steers.length, 2);
  } finally {
    env.cleanup();
  }
});

test('v0.3/S10: 今天有 change/backup/判断/冲突 任一，都不再 steer', () => {
  // 2026-10-30：把「错误」从这个列表里拿掉了。
  //   以前「今天有一条 error」就算有账；但 error 是「被顶」，不等于「进了 L₂」——
  //   被顶了却没立锚时，收工闸现在会拦一次（见下面那条新用例）。
  const cases = [
    (store) => store.appendManifest({ path: 'C:\\x.md', kind: 'change', sha256: 'a', size: 1, mtime: '' }),
    (store) => store.appendManifest({ path: 'C:\\x.md', kind: 'backup', sha256: 'a', size: 1, mtime: '', backup: 'C:\\x.bak' }),
    (store) => store.appendJsonl(store.criteriaLogFile, { t: store.nowIso(), id: 'B1', why: '判断' }),
    (store) => store.appendJsonl(store.conflictsFile, { t: store.nowIso(), topic: '分歧' }),
  ];
  for (const makeEntry of cases) {
    const env = makeEnv({ config: { minIntervalMs: 0 } });
    try {
      makeEntry(env.store);
      const stopper = createTurnStopper({ store: env.store, config: env.config });
      const agent = { steers: [], steer(message) { this.steers.push(message); } };
      stopper({ agent, turn: 1 });
      assert.equal(agent.steers.length, 0, '今天已有账，不应该再敲');
    } finally {
      env.cleanup();
    }
  }
});

test('v0.3/S10: minIntervalMs 内不重复敲，超过间隔才再敲', () => {
  const env = makeEnv({ config: { minIntervalMs: 60 * 60 * 1000 } });
  try {
    let clock = 1_000_000;
    const stopper = createTurnStopper({ store: env.store, config: env.config, now: () => clock });
    const agent = { steers: [], steer(message) { this.steers.push(message); } };

    stopper({ agent, turn: 1 });
    assert.equal(agent.steers.length, 1);

    clock += 10 * 60 * 1000;
    stopper({ agent, turn: 2 });
    assert.equal(agent.steers.length, 1, '10 分钟后不该再敲');

    clock += 50 * 60 * 1000;
    stopper({ agent, turn: 3 });
    assert.equal(agent.steers.length, 2, '满 1 小时后可以再敲');
  } finally {
    env.cleanup();
  }
});

test('S14/六问6: 当日已写 skipped-check 时放行收工', () => {
  const env = makeEnv();
  try {
    env.store.recordError({
      text: '今天不记，休息', source: 'test', level: 'P2', type: 'skipped-check',
    });
    const stopper = createTurnStopper({ store: env.store, config: env.config });
    const agent = { steers: [], steer(message) { this.steers.push(message); } };
    stopper({ agent, turn: 1 });
    assert.equal(agent.steers.length, 0);
  } finally {
    env.cleanup();
  }
});

test('S15: 收工闸拿不到 agent 时写错误账并放行，不抛错', () => {
  const env = makeEnv();
  try {
    const stopper = createTurnStopper({ store: env.store, config: env.config });
    assert.doesNotThrow(() => stopper({ turn: 3 }));
    const errors = env.store.errorRows();
    assert.equal(errors.length, 1);
    assert.equal(errors[0].source, 'turn-gate');
  } finally {
    env.cleanup();
  }
});

test('2026-10-30: 被顶过而锚 0 条时，收工闸拦一次（以前只写不拦）', () => {
  const env = makeEnv();
  try {
    env.store.recordError({ text: '被顶了一条', source: 'test', level: 'P1' });
    const stopper = createTurnStopper({ store: env.store, config: env.config });
    const agent = { steers: [], steer(message) { this.steers.push(message); } };
    stopper({ agent, turn: 1 });
    assert.equal(agent.steers.length, 1, '被顶了却没锚，必须拦一次');
    assert.match(agent.steers[0].content[0].text, /写一条锚/);

    // 一天只拦一次：同一实例再收工，不再敲第二遍
    stopper({ agent, turn: 2 });
    assert.equal(agent.steers.length, 1, '同一天不重复拦');
  } finally {
    env.cleanup();
  }
});

test('2026-10-30: 跳过检查不算「被顶」，不该触发锚的拦截', () => {
  const env = makeEnv();
  try {
    env.store.recordError({
      text: '今天只是跳过', source: 'test', level: 'P2', type: 'skipped-check',
    });
    const stopper = createTurnStopper({ store: env.store, config: env.config });
    const agent = { steers: [], steer(message) { this.steers.push(message); } };
    stopper({ agent, turn: 1 });
    assert.equal(agent.steers.length, 0, '跳过 ≠ 被顶');
  } finally {
    env.cleanup();
  }
});

test('S11: 没有待提示的备份时 post-execute 只透传 next 的结果', async () => {
  const post = createPostExecute(new WeakMap());
  const decision = await post({ name: 'write' }, { content: [] }, async () => ({ kind: 'accept' }));
  assert.deepEqual(decision, { kind: 'accept' });
});
