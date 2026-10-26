/**
 * git.js — 让「改了哪些文件」有一份账本之外的证人。
 *
 * 账本里 `改N` 原本只数 manifest 自己写的行，于是「改了但没经过插件」
 * 永远看不见（备份闸只拦 write/edit，shell 改文件它根本不知道）。
 * 这里用 git 当独立证人：只要仓库里动了文件，git 一定看得见。
 *
 * 零依赖：只调系统 git。找不到 git、不是仓库、没有配置，都安静地返回空。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CACHE_MS = 60 * 1000;
const cache = new Map();

function runGit(cwd, args, timeout = 8000) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
}

function isRepo(dir) {
  try {
    return runGit(dir, ['rev-parse', '--is-inside-work-tree'], 4000).trim() === 'true';
  } catch {
    return false;
  }
}

/** 解析 `git status --porcelain=v1 -z`：每条 NUL 结尾，重命名条目里含两个路径。 */
function parseStatusZ(out) {
  const parts = String(out).split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const rel = entry.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i += 1; // 下一条是改前旧名
    if (xy === '!!') continue;
    entries.push({ xy, rel });
  }
  return entries;
}

/** 今天提交过的文件。 */
function committedToday(dir, today) {
  const out = runGit(dir, [
    'log',
    `--since=${today} 00:00:00`,
    '--name-only',
    '--pretty=format:',
    '--diff-filter=ACMR',
  ]);
  return String(out)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {{watchRepos?: string[]}} config
 * @param {string} today YYYY-MM-DD
 * @param {{force?: boolean}} opts
 * @returns {{all: string[], modified: string[], repos: number, skipped: string[], errors: string[]}}
 */
export function collectGitChanges(config, today, opts = {}) {
  const empty = { all: [], modified: [], repos: 0, skipped: [], errors: [] };
  const repos = Array.isArray(config?.watchRepos) ? config.watchRepos.filter(Boolean) : [];
  if (repos.length === 0) return empty;

  const key = `${today}|${repos.join('|')}`;
  const hit = cache.get(key);
  if (!opts.force && hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const all = new Set();
  const modified = new Set();
  const skipped = [];
  const errors = [];
  let used = 0;

  for (const raw of repos) {
    const dir = path.resolve(raw);
    try {
      if (!isRepo(dir)) {
        skipped.push(`${dir}（不是 git 仓库）`);
        continue;
      }
      used += 1;
      for (const { rel, xy } of parseStatusZ(runGit(dir, ['status', '--porcelain=v1', '-z']))) {
        const abs = path.resolve(dir, rel);
        all.add(abs);
        // ?? = 新建未跟踪，没有原件可备；D = 已删除，也不必备
        if (!xy.includes('?') && !xy.includes('D')) modified.add(abs);
      }
      for (const rel of committedToday(dir, today)) {
        const abs = path.resolve(dir, rel);
        if (!fs.existsSync(abs)) continue; // 删掉的文件不需要备份
        all.add(abs);
        modified.add(abs);
      }
    } catch (err) {
      const msg = err && err.message ? String(err.message).split('\n')[0] : 'git 调用失败';
      errors.push(`${dir}：${msg}`);
    }
  }

  const value = { all: [...all], modified: [...modified], repos: used, skipped, errors };
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function clearGitCache() {
  cache.clear();
}
