import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeEnv } from './helpers.js';
import { sha256Text } from '../lib/store.js';
import { createTools } from '../lib/tools.js';

const DAY = '2026-10-26';

function legacyFile(env) {
  return path.join(env.dshHome, 'backup', '_manifest.jsonl');
}

function makeLegacy(env, pairs) {
  fs.mkdirSync(path.join(env.dshHome, 'backup'), { recursive: true });
  const rows = [];
  for (const [src, content, t] of pairs) {
    const bak = path.join(env.dshHome, 'backup', `${DAY}-${path.basename(src)}.bak`);
    fs.writeFileSync(bak, content);
    rows.push({ t, src, bak, bytes: Buffer.byteLength(content), sha: sha256Text(content).slice(0, 16) });
  }
  fs.writeFileSync(legacyFile(env), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

test('reconcileLegacy：dry-run 只统计，不写 manifest', () => {
  const env = makeEnv();
  try {
    makeLegacy(env, [
      ['/w/a.md', 'aaa', `${DAY}T03:00:00.000Z`],
      ['/w/b.md', 'bbb', `${DAY}T03:10:00.000Z`],
    ]);
    const result = env.store.reconcileLegacy({ dryRun: true });
    assert.equal(result.imported, 2);
    assert.equal(result.dryRun, true);
    assert.deepEqual(env.store.manifestRows(), []);
  } finally {
    env.cleanup();
  }
});

test('reconcileLegacy：导入行为 imported:true，sha256 对 .bak 重算', () => {
  const env = makeEnv();
  try {
    makeLegacy(env, [['/w/a.md', 'hello', `${DAY}T03:00:00.000Z`]]);
    const result = env.store.reconcileLegacy();
    assert.equal(result.imported, 1);
    const rows = env.store.manifestRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'backup');
    assert.equal(rows[0].imported, true);
    assert.equal(rows[0].path, path.resolve('/w/a.md'));
    assert.equal(rows[0].sha256, sha256Text('hello'));
    assert.ok(fs.existsSync(rows[0].backup));
  } finally {
    env.cleanup();
  }
});

test('reconcileLegacy：重复执行幂等（第二次导入 0 条）', () => {
  const env = makeEnv();
  try {
    makeLegacy(env, [
      ['/w/a.md', 'aaa', `${DAY}T03:00:00.000Z`],
      ['/w/b.md', 'bbb', `${DAY}T03:10:00.000Z`],
    ]);
    assert.equal(env.store.reconcileLegacy().imported, 2);
    const second = env.store.reconcileLegacy();
    assert.equal(second.imported, 0);
    assert.equal(second.skipped, 2);
    assert.equal(env.store.manifestRows().length, 2);
  } finally {
    env.cleanup();
  }
});

test('reconcileLegacy：.bak 不存在的旧记录跳过，坏行计入 bad', () => {
  const env = makeEnv();
  try {
    fs.mkdirSync(path.join(env.dshHome, 'backup'), { recursive: true });
    const rows = [
      { t: `${DAY}T03:00:00.000Z`, src: '/w/gone.md', bak: path.join(env.dshHome, 'backup', 'nope.bak'), bytes: 1 },
    ];
    fs.writeFileSync(legacyFile(env), `${rows.map((r) => JSON.stringify(r)).join('\n')}\nnot-json\n`);
    const result = env.store.reconcileLegacy();
    assert.equal(result.imported, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.bad, 1);
  } finally {
    env.cleanup();
  }
});

test('counts：导入的 backup 同时算改动，改=备 对平', () => {
  const env = makeEnv();
  try {
    makeLegacy(env, [
      ['/w/a.md', 'aaa', `${DAY}T03:00:00.000Z`],
      ['/w/b.md', 'bbb', `${DAY}T03:10:00.000Z`],
    ]);
    env.store.reconcileLegacy();
    const counts = env.store.counts(DAY);
    assert.equal(counts.edits, 2);
    assert.equal(counts.backups, 2);
    assert.equal(counts.imported, 2);
  } finally {
    env.cleanup();
  }
});

test('brokenBackups：manifest 指向的 .bak 被删后能被发现', () => {
  const env = makeEnv();
  try {
    makeLegacy(env, [['/w/a.md', 'hello', `${DAY}T03:00:00.000Z`]]);
    env.store.reconcileLegacy();
    const row = env.store.manifestRows()[0];
    fs.rmSync(row.backup);
    assert.equal(env.store.brokenBackups().length, 1);
  } finally {
    env.cleanup();
  }
});

test('ledger_today：对账后显示导入注记，坏备份给警告', async () => {
  const env = makeEnv();
  try {
    makeLegacy(env, [['/w/a.md', 'hello', `${DAY}T03:00:00.000Z`]]);
    const tools = createTools(env.store, env.config);
    const today = tools.find((t) => t.name === 'ledger_today');
    const result = await today.execute({}, {});
    assert.equal(result.ok, true);
    assert.match(result.text, /改1 备1（含1导入）/);
  } finally {
    env.cleanup();
  }
});

test('ledger_today：坏备份不静默，输出失效警告', async () => {
  const env = makeEnv();
  try {
    makeLegacy(env, [['/w/a.md', 'hello', `${DAY}T03:00:00.000Z`]]);
    env.store.reconcileLegacy();
    fs.rmSync(env.store.manifestRows()[0].backup);
    const tools = createTools(env.store, env.config);
    const today = tools.find((t) => t.name === 'ledger_today');
    const result = await today.execute({}, {});
    assert.match(result.text, /⚠备份记录已失效/);
  } finally {
    env.cleanup();
  }
});
