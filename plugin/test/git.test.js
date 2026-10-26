import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { clearGitCache, collectGitChanges } from '../lib/git.js';
import { makeEnv } from './helpers.js';

function git(cwd, args) {
  // 提交日期钉在「昨天」，否则 --since=今天 会把初始化提交也算成今天的改动
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: '2026-10-25T12:00:00+08:00',
    GIT_COMMITTER_DATE: '2026-10-25T12:00:00+08:00',
  };
  // stdout 重定向到临时文件而不是管道：DSH 沙箱禁止子进程管道（会 EPERM）。
  const outFile = path.join(os.tmpdir(), `leno-git-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}.out`);
  const fd = fs.openSync(outFile, 'w+');
  try {
    execFileSync(
      'git',
      ['-c', 'core.quotepath=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
      { cwd, stdio: ['ignore', fd, 'ignore'], env, windowsHide: true },
    );
    return fs.readFileSync(outFile, 'utf8');
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(outFile); } catch { /* ignore */ }
  }
}

function makeRepo(root) {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

test('没配 watchRepos 就什么都不做', () => {
  clearGitCache();
  const out = collectGitChanges({}, '2026-10-26');
  assert.deepEqual(out.all, []);
  assert.deepEqual(out.modified, []);
  assert.equal(out.repos, 0);
});

test('已存在文件被改：算 all 也算 modified', () => {
  clearGitCache();
  const env = makeEnv();
  try {
    const repo = makeRepo(env.root);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    const out = collectGitChanges({ watchRepos: [repo] }, '2026-10-26', { force: true });
    assert.equal(out.repos, 1);
    assert.equal(out.all.length, 1);
    assert.equal(out.modified.length, 1);
    assert.ok(out.all[0].endsWith('a.txt'));
  } finally {
    env.cleanup();
  }
});

test('新建未跟踪文件：算 all，不算 modified（没有原件可备）', () => {
  clearGitCache();
  const env = makeEnv();
  try {
    const repo = makeRepo(env.root);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n');
    const out = collectGitChanges({ watchRepos: [repo] }, '2026-10-26', { force: true });
    assert.equal(out.all.length, 1);
    assert.equal(out.modified.length, 0);
  } finally {
    env.cleanup();
  }
});

test('不是 git 仓库：跳过，不抛错', () => {
  clearGitCache();
  const env = makeEnv();
  try {
    const plain = path.join(env.root, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    const out = collectGitChanges({ watchRepos: [plain] }, '2026-10-26', { force: true });
    assert.equal(out.all.length, 0);
    assert.equal(out.repos, 0);
    assert.equal(out.skipped.length, 1);
  } finally {
    env.cleanup();
  }
});

test('同一个小时里缓存生效，force 能绕过', () => {
  clearGitCache();
  const env = makeEnv();
  try {
    const repo = makeRepo(env.root);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    const first = collectGitChanges({ watchRepos: [repo] }, '2026-10-26', { force: true });
    fs.writeFileSync(path.join(repo, 'c.txt'), 'more\n');
    const cached = collectGitChanges({ watchRepos: [repo] }, '2026-10-26');
    assert.equal(cached.all.length, first.all.length);
    const forced = collectGitChanges({ watchRepos: [repo] }, '2026-10-26', { force: true });
    assert.equal(forced.all.length, 2);
  } finally {
    env.cleanup();
  }
});

test('counts 把 git 看见的改动算进「改」，并指出有改没备份', () => {
  clearGitCache();
  const env = makeEnv();
  try {
    const repo = makeRepo(env.root);
    const tracked = path.join(repo, 'a.txt');
    fs.writeFileSync(tracked, 'two\n');
    const out = collectGitChanges({ watchRepos: [repo] }, '2026-10-26', { force: true });
    const counts = env.store.counts('2026-10-26', out);
    assert.equal(counts.edits, 1);
    assert.equal(counts.byGit, 1);
    assert.deepEqual(counts.unbacked, [tracked]);
  } finally {
    env.cleanup();
  }
});
