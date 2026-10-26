import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { makeEnv } from './helpers.js';

const LIB = pathToFileURL(path.join(import.meta.dirname, '..', 'lib')).href;

function runWorker(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const WORKER = `
import { resolveConfig } from '${LIB}/config.js';
import { Store } from '${LIB}/store.js';
const [dshHome, label, count] = process.argv.slice(1);
const config = resolveConfig({ dshHome });
const store = new Store(config);
store.ensureDirs();
for (let i = 0; i < Number(count); i += 1) {
  store.appendLine(store.undoneFile, { t: store.nowIso(), text: label + '#' + i });
}
process.stdout.write('done ' + label);
`;

test('两个进程同时追加，一行不丢', async () => {
  const env = makeEnv();
  try {
    const count = 25;
    const results = await Promise.all([
      runWorker(WORKER, [env.dshHome, 'a', String(count)]),
      runWorker(WORKER, [env.dshHome, 'b', String(count)]),
    ]);
    for (const r of results) {
      assert.equal(r.code, 0, r.err);
    }
    const text = fs.readFileSync(env.store.undoneFile, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    assert.equal(lines.length, count * 2);
    for (const line of lines) JSON.parse(line); // 每一行都还能解析
    const labels = new Set(lines.map((l) => JSON.parse(l).text.split('#')[0]));
    assert.deepEqual([...labels].sort(), ['a', 'b']);
  } finally {
    env.cleanup();
  }
});

test('锁文件在结束后不残留', async () => {
  const env = makeEnv();
  try {
    env.store.appendLine(env.store.undoneFile, { t: env.store.nowIso(), text: 'x' });
    assert.equal(fs.existsSync(env.store.lockPath), false);
  } finally {
    env.cleanup();
  }
});

test('残留的旧锁会被抢过来，不会卡死', async () => {
  const env = makeEnv();
  try {
    fs.mkdirSync(path.dirname(env.store.lockPath), { recursive: true });
    fs.writeFileSync(env.store.lockPath, '{"pid":999999}', 'utf8');
    const old = new Date(Date.now() - 120 * 1000);
    fs.utimesSync(env.store.lockPath, old, old);
    env.store.appendLine(env.store.undoneFile, { t: env.store.nowIso(), text: 'after-steal' });
    assert.equal(fs.readFileSync(env.store.undoneFile, 'utf8').includes('after-steal'), true);
  } finally {
    env.cleanup();
  }
});
