import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createTools } from '../lib/tools.js';
import { makeEnv, toolByName } from './helpers.js';

test('S7/S20: 首次备份落到 backup/<日期>/<name>.bak 并追加 manifest 字段', () => {
  const env = makeEnv();
  try {
    const file = path.join(env.dshHome, 'target.md');
    fs.writeFileSync(file, '原文内容', 'utf8');

    const result = env.store.backupFile(file);
    assert.equal(result.ok, true);
    assert.equal(result.dedup, false);
    assert.equal(result.backupPath, path.join(env.store.backupRoot, '2026-10-26', 'target.md.bak'));
    assert.equal(fs.readFileSync(result.backupPath, 'utf8'), '原文内容');

    const rows = env.store.manifestRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].path, file);
    assert.equal(rows[0].kind, 'backup');
    assert.equal(rows[0].sha256, result.sha256);
    assert.equal(rows[0].size, Buffer.byteLength('原文内容', 'utf8'));
    assert.match(rows[0].mtime, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(rows[0].backup, result.backupPath);
    assert.equal(env.store.dateOf(rows[0].t), '2026-10-26');
  } finally {
    env.cleanup();
  }
});

test('S7/S20: 同日同内容第二次备份 dedup:true，不追加 manifest', () => {
  const env = makeEnv();
  try {
    const file = path.join(env.dshHome, 'same.md');
    fs.writeFileSync(file, '不变', 'utf8');
    const first = env.store.backupFile(file);
    const second = env.store.backupFile(file);
    assert.equal(second.dedup, true);
    assert.equal(second.backupPath, first.backupPath);
    assert.equal(env.store.manifestRows().length, 1);
  } finally {
    env.cleanup();
  }
});

test('S7/六问4: 内容变了必须再备，文件名依次加 -2/-3', () => {
  const env = makeEnv();
  try {
    const file = path.join(env.dshHome, 'change.md');
    fs.writeFileSync(file, 'v1', 'utf8');
    const first = env.store.backupFile(file);
    fs.writeFileSync(file, 'v2', 'utf8');
    const second = env.store.backupFile(file);
    fs.writeFileSync(file, 'v3', 'utf8');
    const third = env.store.backupFile(file);

    assert.equal(first.backupPath.endsWith('change.md.bak'), true);
    assert.equal(second.backupPath.endsWith('change.md-2.bak'), true);
    assert.equal(third.backupPath.endsWith('change.md-3.bak'), true);
    assert.equal(fs.readFileSync(first.backupPath, 'utf8'), 'v1');
    assert.equal(fs.readFileSync(second.backupPath, 'utf8'), 'v2');
    assert.equal(fs.readFileSync(third.backupPath, 'utf8'), 'v3');
    assert.equal(env.store.manifestRows().length, 3);

    const dedupAgain = env.store.backupFile(file);
    assert.equal(dedupAgain.dedup, true);
  } finally {
    env.cleanup();
  }
});

test('S7: ledger_backup 对不存在的路径返回错误，不写 manifest', async () => {
  const env = makeEnv();
  try {
    const tools = new Map(createTools(env.store, env.config).map((t) => [t.name, t]));
    const result = await toolByName(tools, 'ledger_backup').execute({
      file_path: path.join(env.dshHome, 'nope.md'),
    });
    assert.equal(result.ok, false);
    assert.match(result.text, /路径不存在/);
    assert.equal(env.store.manifestRows().length, 0);
  } finally {
    env.cleanup();
  }
});

test('S7: ledger_backup 成功时返回 dedup/backupPath，并写可解析 manifest', async () => {
  const env = makeEnv();
  try {
    const file = path.join(env.dshHome, 'tool.md');
    fs.writeFileSync(file, 'tool backup', 'utf8');
    const tools = new Map(createTools(env.store, env.config).map((t) => [t.name, t]));
    const tool = toolByName(tools, 'ledger_backup');

    const first = await tool.execute({ file_path: file });
    assert.equal(first.ok, true);
    assert.equal(first.dedup, false);
    assert.ok(first.backupPath.endsWith('tool.md.bak'));

    const second = await tool.execute({ file_path: file });
    assert.equal(second.dedup, true);
    assert.equal(env.store.manifestRows().length, 1);
  } finally {
    env.cleanup();
  }
});

test('S8: ledger_backup 把相对路径解析为绝对路径', async () => {
  const env = makeEnv();
  try {
    const file = path.join(env.root, 'relative.md');
    fs.writeFileSync(file, 'rel', 'utf8');
    const tools = new Map(createTools(env.store, env.config).map((t) => [t.name, t]));
    const previous = process.cwd();
    process.chdir(env.root);
    try {
      const result = await toolByName(tools, 'ledger_backup').execute({ file_path: 'relative.md' });
      assert.equal(result.ok, true);
      assert.equal(env.store.manifestRows()[0].path, file);
    } finally {
      process.chdir(previous);
    }
  } finally {
    env.cleanup();
  }
});
