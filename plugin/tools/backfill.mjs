#!/usr/bin/env node
/**
 * backfill.mjs — 离线补账（不需要模型上下文）。
 *
 * 扫 watchRepos 里「今天 git 改动过、且今天没有对应备份」的已存在文件，
 * 补一条 backup + 一条 change(source:"backfill")。默认 --dry-run，只打印清单；
 * 加 --apply 才写盘。幂等：同 path + 同 sha256 + 同一天已备过就跳过。
 *
 * 用法：
 *   node plugin/tools/backfill.mjs --repo <仓库> [--repo <仓库2>] [--apply]
 *   node plugin/tools/backfill.mjs --home <DSH_HOME> [--workspace <根>] --repo <仓库> [--apply]
 */
import fs from 'node:fs';

import {
  contextFromArgs, fail, parseArgs, print,
} from './_shared.mjs';
import { matchIgnore } from '../lib/config.js';
import { collectGitChanges } from '../lib/git.js';
import { truncate } from '../lib/store.js';

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    print('用法: node plugin/tools/backfill.mjs --repo <仓库> [--repo <仓库2>] [--apply] [--home <DSH_HOME>]');
    return 0;
  }

  const { config, store } = contextFromArgs(opts);
  if (config.watchRepos.length === 0) {
    print('watchRepos 为空：用 --repo <路径> 指定仓库，或在插件配置里设置 watchRepos。');
    return 0;
  }

  const today = store.today();
  const git = collectGitChanges({ watchRepos: config.watchRepos }, today, { force: true });
  for (const item of git.skipped) print(`跳过仓库：${item}`);
  for (const item of git.errors) print(`⚠ git 读不到：${item}`);

  const todo = [];
  const skip = [];
  for (const abs of git.modified) {
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      skip.push(`${abs}（文件已不存在）`);
      continue;
    }
    if (!stat.isFile() || stat.size === 0) {
      skip.push(`${abs}（空文件/非普通文件）`);
      continue;
    }
    if (matchIgnore(abs, config.ignore)) {
      skip.push(`${abs}（忽略清单）`);
      continue;
    }
    if (Number.isFinite(config.maxBackupBytes) && stat.size > config.maxBackupBytes) {
      skip.push(`${abs}（超过 maxBackupBytes）`);
      continue;
    }

    const sha256 = store.sha256File(abs);
    const already = store.findTodayBackup(abs, sha256, today)
      || store.manifestRows().some(
        (r) => r.kind === 'change' && r.path === abs && r.sha256 === sha256
          && store.dateOf(r.t) === today,
      );
    if (already) {
      skip.push(`${abs}（今日已备过）`);
      continue;
    }
    todo.push({ abs, sha256, size: stat.size, mtime: new Date(stat.mtimeMs).toISOString() });
  }

  todo.sort((a, b) => a.abs.localeCompare(b.abs));
  print(`扫描 ${git.repos} 个仓库：今日改动 ${git.all.length} 个文件，缺备份 ${todo.length} 个；跳过 ${skip.length} 个。`);
  for (const item of todo) print(`${opts.apply ? '补' : '将补'}：${item.abs}（${item.size} 字节，sha256 ${item.sha256.slice(0, 12)}）`);
  for (const item of skip) print(`跳过：${item}`);

  if (!opts.apply) {
    print(`--dry-run：未写盘。确认后加 --apply（将补 ${todo.length} 个）。`);
    return 0;
  }

  let done = 0;
  const failed = [];
  for (const item of todo) {
    try {
      const result = store.backupFile(item.abs);
      store.appendManifest({
        path: item.abs,
        kind: 'change',
        sha256: item.sha256,
        size: item.size,
        mtime: item.mtime,
        source: 'backfill',
        backup: result.backupPath,
      });
      done += 1;
      print(`已补：${item.abs} -> ${result.backupPath}`);
    } catch (error) {
      failed.push(`${item.abs}：${String(error?.message ?? error)}`);
    }
  }
  print(`完成：补了 ${done} 个，失败 ${failed.length} 个。`);
  for (const item of failed) print(`✖ ${truncate(item, 200)}`);
  return failed.length > 0 ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (error) {
  fail(`backfill.mjs 异常：${error?.message ?? error}`);
}
