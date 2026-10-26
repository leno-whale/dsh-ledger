import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { makeEnv } from './helpers.js';

const LIB = pathToFileURL(path.join(import.meta.dirname, '..', 'lib')).href;

function runWorker(script, args) {
  // 不用 pipe：受限环境禁止子进程管道；stdout/stderr 直接落临时文件。
  const tag = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const outFile = path.join(os.tmpdir(), `leno-lock-${tag}.out`);
  const errFile = path.join(os.tmpdir(), `leno-lock-${tag}.err`);
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], {
      stdio: ['ignore', outFd, errFd],
    });
    child.on('close', (code) => {
      try { fs.closeSync(outFd); } catch { /* ignore */ }
      try { fs.closeSync(errFd); } catch { /* ignore */ }
      let out = '';
      let err = '';
      try { out = fs.readFileSync(outFile, 'utf8'); } catch { /* ignore */ }
      try { err = fs.readFileSync(errFile, 'utf8'); } catch { /* ignore */ }
      try { fs.unlinkSync(outFile); } catch { /* ignore */ }
      try { fs.unlinkSync(errFile); } catch { /* ignore */ }
      resolve({ code, out, err });
    });
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
