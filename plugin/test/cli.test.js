import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import plugin from '../lib/index.js';
import { todayFirstLine } from '../lib/today.js';
import { makeEnv, mockCtx } from './helpers.js';

const TOOLS = path.join(import.meta.dirname, '..', 'tools');
const STATUS = path.join(TOOLS, 'status.mjs');
const TODAY = path.join(TOOLS, 'today.mjs');
const BACKFILL = path.join(TOOLS, 'backfill.mjs');

/** 子进程 stdout/stderr 落临时文件（不用管道：受限环境会 EPERM）。 */
function runNode(script, args, options = {}) {
  const tag = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const outFile = path.join(os.tmpdir(), `leno-cli-${tag}.out`);
  const errFile = path.join(os.tmpdir(), `leno-cli-${tag}.err`);
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  try {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: options.cwd ?? path.dirname(script),
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
      timeout: 60_000,
    });
    return {
      status: result.status,
      signal: result.signal,
      out: fs.readFileSync(outFile, 'utf8'),
      err: fs.readFileSync(errFile, 'utf8'),
    };
  } finally {
    try { fs.closeSync(outFd); } catch { /* ignore */ }
    try { fs.closeSync(errFd); } catch { /* ignore */ }
    try { fs.unlinkSync(outFile); } catch { /* ignore */ }
    try { fs.unlinkSync(errFile); } catch { /* ignore */ }
  }
}

function git(cwd, args) {
  const tag = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const outFile = path.join(os.tmpdir(), `leno-git-${tag}.out`);
  const fd = fs.openSync(outFile, 'w+');
  try {
    execFileSync(
      'git',
      ['-c', 'core.quotepath=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
      {
        cwd,
        stdio: ['ignore', fd, 'ignore'],
        windowsHide: true,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2026-10-25T12:00:00+08:00',
          GIT_COMMITTER_DATE: '2026-10-25T12:00:00+08:00',
        },
      },
    );
    return fs.readFileSync(outFile, 'utf8');
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(outFile); } catch { /* ignore */ }
  }
}

test('S7: status.mjs 没有 state 时退出 1，并给出可读提示', () => {
  const env = makeEnv();
  try {
    const result = runNode(STATUS, ['--home', env.dshHome]);
    assert.equal(result.status, 1);
    assert.match(result.out, /模块 import：OK/);
    assert.match(result.out, /state：不存在/);
    assert.match(result.out, /最近一条账/);
    assert.match(result.out, /备份文件：0 个/);
    assert.match(result.out, /今日：/);
  } finally {
    env.cleanup();
  }
});

test('S7: apply() 写 state 后 status.mjs 退出 0，并显示五段状态', () => {
  const env = makeEnv();
  const mock = mockCtx();
  try {
    plugin.apply(mock.ctx, env.config);
    const result = runNode(STATUS, ['--home', env.dshHome, '--workspace', env.workspaceRoot]);
    assert.equal(result.status, 0, result.err);
    assert.match(result.out, /state：/);
    assert.match(result.out, /segments: tools=ok guard=ok injection=ok turnStopping=ok postExecute=ok/);
    assert.match(result.out, /version=0\.3\.0/);
    assert.match(result.out, /今日：改0 备0/);
  } finally {
    env.cleanup();
  }
});

test('S7: status.mjs 的 --json 输出可解析，且包含备份数与今日行', () => {
  const env = makeEnv();
  const mock = mockCtx();
  try {
    plugin.apply(mock.ctx, env.config);
    const result = runNode(STATUS, ['--home', env.dshHome, '--json']);
    assert.equal(result.status, 0, result.err);
    const parsed = JSON.parse(result.out);
    assert.equal(parsed.module.ok, true);
    assert.equal(parsed.state.exists, true);
    assert.equal(parsed.state.content.version, '0.3.0');
    assert.equal(parsed.backups.files, 0);
    assert.match(parsed.today.line, /^改0 备0/);
  } finally {
    env.cleanup();
  }
});

test('S9: today.mjs 与 ledger_today 首行完全一致', () => {
  const env = makeEnv();
  try {
    const file = path.join(env.root, 'a.md');
    fs.writeFileSync(file, 'x', 'utf8');
    env.store.backupFile(file);
    env.store.appendManifest({ path: file, kind: 'change', sha256: 'x', size: 1, mtime: '' });
    env.store.appendJsonl(env.store.criteriaLogFile, { t: env.store.nowIso(), id: 'B1', why: '判断' });
    env.store.recordError({ text: '错', source: 't', level: 'P1' });
    env.store.appendJsonl(env.store.conflictsFile, { t: env.store.nowIso(), topic: '分歧' });

    const expected = todayFirstLine(env.store, env.config);
    const result = runNode(TODAY, [
      '--home', env.dshHome, '--workspace', env.workspaceRoot, '--now', '2026-10-26T10:00:00.000Z',
    ]);
    assert.equal(result.status, 0, result.err);
    assert.equal(result.out.trim(), expected);
    assert.match(result.out.trim(), /^改1 备1 \| 判断1 记1 \| 冲突1 \| 今日事件：无$/);
  } finally {
    env.cleanup();
  }
});

function makeRepo(root) {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\n', 'utf8');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

test('S8: backfill 默认 dry-run 不写，--apply 补 backup+change，重复跑幂等', () => {
  const env = makeEnv();
  try {
    const repo = makeRepo(env.root);
    const file = path.join(repo, 'tracked.txt');
    fs.writeFileSync(file, 'two\n', 'utf8');

    const dry = runNode(BACKFILL, ['--home', env.dshHome, '--repo', repo]);
    assert.equal(dry.status, 0, dry.err);
    assert.match(dry.out, /将补：/);
    assert.match(dry.out, /--dry-run：未写盘/);
    assert.equal(env.store.manifestRows().filter((r) => r.kind === 'backup').length, 0);
    assert.equal(env.store.manifestRows().filter((r) => r.kind === 'change').length, 0);

    const applied = runNode(BACKFILL, ['--home', env.dshHome, '--repo', repo, '--apply']);
    assert.equal(applied.status, 0, applied.err);
    assert.match(applied.out, /已补：/);
    const changes = env.store.manifestRows().filter((r) => r.kind === 'change');
    const backups = env.store.manifestRows().filter((r) => r.kind === 'backup');
    assert.equal(changes.length, 1);
    assert.equal(changes[0].source, 'backfill');
    assert.equal(changes[0].path, file);
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(backups[0].backup, 'utf8'), 'two\n');

    const again = runNode(BACKFILL, ['--home', env.dshHome, '--repo', repo, '--apply']);
    assert.equal(again.status, 0, again.err);
    assert.match(again.out, /今日已备过/);
    assert.equal(env.store.manifestRows().filter((r) => r.kind === 'change').length, 1);
    assert.equal(env.store.manifestRows().filter((r) => r.kind === 'backup').length, 1);
  } finally {
    env.cleanup();
  }
});

test('S8: backfill 不扫新建未跟踪文件（没有原件可备）', () => {
  const env = makeEnv();
  try {
    const repo = makeRepo(env.root);
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n', 'utf8');
    const result = runNode(BACKFILL, ['--home', env.dshHome, '--repo', repo, '--apply']);
    assert.equal(result.status, 0, result.err);
    assert.equal(env.store.manifestRows().filter((r) => r.kind === 'change').length, 0);
  } finally {
    env.cleanup();
  }
});

test('S8: watchRepos 为空时给出提示而不是报错', () => {
  const env = makeEnv();
  try {
    const result = runNode(BACKFILL, ['--home', env.dshHome]);
    assert.equal(result.status, 0);
    assert.match(result.out, /watchRepos 为空/);
  } finally {
    env.cleanup();
  }
});
