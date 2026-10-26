#!/usr/bin/env node
/**
 * 一次性对账脚本：把旧的平铺备份账（~/.dsh/backup/_manifest.jsonl）补进插件 manifest。
 *
 * 用法：
 *   node plugin/tools/import-legacy-backups.mjs --dry    # 只统计，不写
 *   node plugin/tools/import-legacy-backups.mjs          # 正式导入（幂等，可重复跑）
 *   node plugin/tools/import-legacy-backups.mjs --json   # 机器可读输出
 *
 * 说明：
 * - 旧账的 sha 只有 16 位，不能直接当 sha256 用，所以对 *.bak 重新计算；
 * - 幂等键 = 源路径 | sha256 | 日期，重复执行不会重复入账；
 * - 导入行带 imported:true，ledger_today 会显示“含N导入”，不会冒充“经过闸的备份”。
 */
import fs from 'node:fs';
import path from 'node:path';

import { resolveConfig } from '../lib/config.js';
import { Store } from '../lib/store.js';

const argv = new Set(process.argv.slice(2));
const dryRun = argv.has('--dry');
const asJson = argv.has('--json');

const config = resolveConfig({});
const store = new Store(config);
const legacyFile = path.join(config.dshHome, 'backup', '_manifest.jsonl');

if (!fs.existsSync(legacyFile)) {
  if (asJson) {
    console.log(JSON.stringify({ legacyFile, imported: 0, skipped: 0, bad: 0, broken: 0, dryRun, note: 'no legacy manifest' }));
  } else {
    console.log(`没有旧备份账：${legacyFile}（无需导入）`);
  }
  process.exit(0);
}

const result = store.reconcileLegacy({ dryRun });
const broken = store.brokenBackups().length;

if (asJson) {
  console.log(JSON.stringify({ legacyFile, ...result, broken }, null, 2));
} else {
  console.log(`${dryRun ? '[dry-run] ' : ''}旧备份账：${legacyFile}`);
  console.log(
    `导入 ${result.imported} 条，跳过 ${result.skipped} 条，坏行 ${result.bad} 行`
    + (broken > 0 ? `，已失效备份 ${broken} 条（.bak 已不存在，记入坏账提示）` : ''),
  );
  if (dryRun) console.log('（dry-run 未写 manifest；去掉 --dry 执行导入）');
  else console.log('已写入 whale-backup-manifest.jsonl；再跑一次应为「导入 0 条」。');
}
