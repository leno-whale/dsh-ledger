import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { FILES } from '../lib/config.js';
import { makeEnv } from './helpers.js';

function putOld(env, name, body = '{}\n') {
  const file = path.join(env.config.dataDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function putBackup(env, date, name, body = 'x') {
  const file = path.join(env.config.backupRoot, date, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

/** 造出「升级前」的现场：新名字的文件不存在，只有老的 whale-* */
function asLegacy(env) {
  for (const name of Object.values(FILES)) {
    const file = path.join(env.config.dataDir, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) fs.rmSync(file);
  }
}

test('升级现场：老的 whale-* 账被搬到新名字，内容一字不动', () => {
  const env = makeEnv();
  try {
    asLegacy(env);
    const oldManifest = putOld(env, 'whale-backup-manifest.jsonl', '{"a":1}\n');
    const oldErrors = putOld(env, 'whale-error-ledger.jsonl', '{"b":2}\n');
    const actions = env.store.migrateLegacyNames();
    assert.equal(actions.filter((a) => a.action === 'renamed').length, 2);
    assert.equal(fs.existsSync(oldManifest), false);
    assert.equal(fs.existsSync(oldErrors), false);
    assert.equal(fs.existsSync(path.join(env.config.dataDir, FILES.manifest)), true);
    assert.equal(
      fs.readFileSync(path.join(env.config.dataDir, FILES.manifest), 'utf8').trim(),
      '{"a":1}',
    );
  } finally {
    env.cleanup();
  }
});

test('新旧都在时不合并、不删除，记一条迁移错误账', () => {
  const env = makeEnv();
  try {
    putOld(env, 'whale-backup-manifest.jsonl', '{"old":1}\n');
    const newFile = path.join(env.config.dataDir, FILES.manifest);
    fs.writeFileSync(newFile, '{"new":1}\n', 'utf8');
    const actions = env.store.migrateLegacyNames();
    assert.equal(actions.some((a) => a.action === 'kept-both'), true);
    assert.equal(fs.readFileSync(newFile, 'utf8').trim(), '{"new":1}');
    const rows = env.store.errorRows().filter((r) => r.type === 'migration');
    assert.equal(rows.length >= 1, true);
  } finally {
    env.cleanup();
  }
});

test('迁移是幂等的：跑两次只搬一次', () => {
  const env = makeEnv();
  try {
    asLegacy(env);
    putOld(env, 'whale-conflicts.jsonl', '{"c":1}\n');
    assert.equal(env.store.migrateLegacyNames().length, 1);
    assert.equal(env.store.migrateLegacyNames().length, 0);
  } finally {
    env.cleanup();
  }
});

test('只有一个副本的源文件，过期也不删（最新一份永远保留）', () => {
  const env = makeEnv();
  try {
    const only = putBackup(env, '2026-09-01', 'a.md.bak');
    const result = env.store.pruneBackups({ dryRun: true, keepDays: 10 });
    assert.equal(result.removed.length, 0);
    assert.equal(fs.existsSync(only), true);
  } finally {
    env.cleanup();
  }
});

test('dryRun 只算不删', () => {
  const env = makeEnv();
  try {
    const older = putBackup(env, '2026-09-01', 'a.md.bak');
    putBackup(env, '2026-09-02', 'a.md-2.bak');
    const result = env.store.pruneBackups({ dryRun: true, keepDays: 10 });
    assert.equal(result.removed.length, 1);
    assert.equal(result.removed[0].date, '2026-09-01');
    assert.equal(fs.existsSync(older), true);
  } finally {
    env.cleanup();
  }
});

test('真删：过期目录里较旧的那份删掉，最新一份留下', () => {
  const env = makeEnv();
  try {
    const older = putBackup(env, '2026-09-01', 'a.md.bak');
    const newer = putBackup(env, '2026-09-02', 'a.md-2.bak');
    const result = env.store.pruneBackups({ dryRun: false, keepDays: 10 });
    assert.equal(result.removed.length, 1);
    assert.equal(fs.existsSync(older), false);
    assert.equal(fs.existsSync(newer), true);
    assert.equal(fs.existsSync(path.join(env.config.backupRoot, '2026-09-01')), false);
    assert.equal(fs.existsSync(path.join(env.config.backupRoot, '2026-09-02')), true);
  } finally {
    env.cleanup();
  }
});

test('容量超限从最老的开始删，删到不超限为止', () => {
  const env = makeEnv();
  try {
    const big = 'x'.repeat(2048);
    const first = putBackup(env, '2026-10-01', 'a.md.bak', big);
    const second = putBackup(env, '2026-10-02', 'a.md-2.bak', big);
    const third = putBackup(env, '2026-10-03', 'a.md-3.bak', big);
    const result = env.store.pruneBackups({ dryRun: false, keepDays: 0, maxTotalBytes: 3000 });
    assert.equal(result.removed.length, 2);
    assert.equal(fs.existsSync(first), false);
    assert.equal(fs.existsSync(second), false);
    assert.equal(fs.existsSync(third), true);
  } finally {
    env.cleanup();
  }
});

test('清理会写一条 prune 账（只记数，不记路径）', () => {
  const env = makeEnv();
  try {
    putBackup(env, '2026-09-01', 'a.md.bak');
    putBackup(env, '2026-09-02', 'a.md-2.bak');
    env.store.pruneBackups({ dryRun: false, keepDays: 10 });
    const rows = env.store.readJsonl(env.store.pruneLogFile, { recordCorruption: false }).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].removed, 1);
    assert.equal(rows[0].keepDays, 10);
    assert.equal(JSON.stringify(rows[0]).includes('.bak'), false);
  } finally {
    env.cleanup();
  }
});

test('备份目录不存在时不报错', () => {
  const env = makeEnv();
  try {
    fs.rmSync(env.config.backupRoot, { recursive: true, force: true });
    const stats = env.store.backupStats();
    assert.equal(stats.files, 0);
    const result = env.store.pruneBackups({ dryRun: false });
    assert.equal(result.removed.length, 0);
  } finally {
    env.cleanup();
  }
});
