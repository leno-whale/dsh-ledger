import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { dateInZone } from '../lib/store.js';
import {
  FIXED_NOW, listTmpFiles, makeEnv, writeWorkspaceFile,
} from './helpers.js';

test('S1: 日期按配置时区计算，不受进程 TZ 影响', () => {
  assert.equal(dateInZone(new Date('2026-10-26T15:59:59.000Z'), 'Asia/Shanghai'), '2026-10-26');
  assert.equal(dateInZone(new Date('2026-10-26T16:00:00.000Z'), 'Asia/Shanghai'), '2026-10-27');
  assert.equal(dateInZone(new Date('2026-10-26T16:00:00.000Z'), 'UTC'), '2026-10-26');
});

test('S3/S20: 原子写落盘完整，且不残留 tmp', () => {
  const env = makeEnv();
  try {
    const file = path.join(env.dshHome, 'atomic.md');
    env.store.atomicWrite(file, '第一版\n第二行\n');
    assert.equal(fs.readFileSync(file, 'utf8'), '第一版\n第二行\n');
    assert.deepEqual(listTmpFiles(env.dshHome), []);
  } finally {
    env.cleanup();
  }
});

test('S20: 原子写中途的残留 tmp 不会变成半文件，也不影响后续写入', () => {
  const env = makeEnv();
  try {
    const file = path.join(env.dshHome, 'half.md');
    const stale = `${file}.999.deadbeef.tmp`;
    fs.writeFileSync(stale, '写到一半', 'utf8');

    env.store.atomicWrite(file, '完整内容');
    assert.equal(fs.readFileSync(file, 'utf8'), '完整内容');

    const leftovers = listTmpFiles(env.dshHome);
    assert.deepEqual(leftovers, [path.basename(stale)]);

    fs.unlinkSync(stale);
    env.store.atomicWrite(file, '第二版');
    assert.equal(fs.readFileSync(file, 'utf8'), '第二版');
    assert.deepEqual(listTmpFiles(env.dshHome), []);
  } finally {
    env.cleanup();
  }
});

test('S4/S20: 损坏 JSONL 跳过坏行、写一条错误账、且同坏行数不重复记', () => {
  const env = makeEnv();
  try {
    const file = path.join(env.dshHome, 'whale-conflicts.jsonl');
    fs.writeFileSync(file, '{"t":"2026-10-26T01:00:00.000Z","topic":"a"}\n{坏行\n[1,2]\n', 'utf8');

    const first = env.store.readJsonl(file);
    assert.equal(first.rows.length, 1);
    assert.equal(first.bad, 2);

    const errors = env.store.errorRows().filter((r) => r.type === 'corrupt');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].level, 'P2');
    assert.match(errors[0].text, /2 行无法解析/);

    env.store.readJsonl(file);
    assert.equal(env.store.errorRows().filter((r) => r.type === 'corrupt').length, 1);
  } finally {
    env.cleanup();
  }
});

test('S4: 追加会丢弃坏行并留下可解析文件', () => {
  const env = makeEnv();
  try {
    const file = path.join(env.dshHome, 'whale-undone.jsonl');
    fs.writeFileSync(file, '{"t":"2026-10-26T01:00:00.000Z","text":"好的"}\n不是 JSON\n', 'utf8');

    env.store.appendJsonl(file, { t: env.store.nowIso(), text: '新的' });
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.split('\n').filter(Boolean).length, 2);
    for (const line of text.split('\n').filter(Boolean)) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
    assert.equal(env.store.readJsonl(file).rows.length, 2);
  } finally {
    env.cleanup();
  }
});

test('S1/S22: 路径全部由 DSH_HOME/workspaceRoot 推出，测试不碰真实 ~/.dsh', async () => {
  const env = makeEnv();
  const previous = process.env.DSH_HOME;
  try {
    assert.ok(env.store.conflictsFile.startsWith(env.dshHome));
    assert.ok(env.store.sayDir.startsWith(env.workspaceRoot));
    assert.equal(path.dirname(env.store.backupRoot), env.dshHome);

    process.env.DSH_HOME = env.dshHome;
    const { resolveConfig } = await import('../lib/config.js');
    assert.equal(resolveConfig({}).dshHome, env.dshHome);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    env.cleanup();
  }
});

test('S6 计数：改=当日去重路径，备=当日备份条数，记=当日错误账', async () => {
  const env = makeEnv();
  try {
    const today = env.store.today();
    assert.equal(today, '2026-10-26');

    env.store.appendManifest({ path: 'C:\\a.md', kind: 'create', sha256: '', size: 0, mtime: '' });
    env.store.appendManifest({ path: 'C:\\a.md', kind: 'edit', sha256: 'x', size: 1, mtime: '' });
    env.store.appendManifest({
      path: 'C:\\a.md', kind: 'backup', sha256: 'x', size: 1, mtime: '', backup: 'C:\\b.bak',
    });
    env.store.appendJsonl(env.store.manifestFile, {
      t: '2026-10-25T10:00:00.000Z', path: 'C:\\old.md', kind: 'edit', sha256: '', size: 0, mtime: '',
    });
    env.store.appendJsonl(env.store.errorFile, {
      t: FIXED_NOW().toISOString(), type: 'error', text: '昨天之前的错', source: 't', level: 'P1', ref: '',
    });
    env.store.appendJsonl(env.store.errorFile, {
      t: '2026-10-25T10:00:00.000Z', type: 'error', text: '更早的错', source: 't', level: 'P1', ref: '',
    });

    const counts = env.store.counts(today);
    assert.equal(counts.edits, 1);
    assert.equal(counts.backups, 1);
    assert.equal(counts.errors, 1);
    assert.equal(counts.errorsTotal, 2);
  } finally {
    env.cleanup();
  }
});

test('S17: 近 7 天 0 引用的规矩 = 规矩全集 - 近期用过的', () => {
  const env = makeEnv();
  try {
    writeWorkspaceFile(env, path.join('接口', '规矩', '发一条之前.md'), '# 规矩\n');
    writeWorkspaceFile(env, path.join('接口', '规矩', '收工对账.md'), '# 规矩\n');
    env.store.writeJson(env.store.ruleUsageFile, {
      发一条之前: { n: 2, last: '2026-10-25T00:00:00.000Z' },
      收工对账: { n: 1, last: '2026-10-01T00:00:00.000Z' },
    });
    const zero = env.store.zeroRefRules(7);
    assert.deepEqual(zero, ['收工对账']);
  } finally {
    env.cleanup();
  }
});
