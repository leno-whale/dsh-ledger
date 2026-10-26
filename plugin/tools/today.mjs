#!/usr/bin/env node
/**
 * today.mjs — 纯文件复算 ledger_today 的第一行，不需要模型/工具。
 *
 * 用法：
 *   node plugin/tools/today.mjs [--home <DSH_HOME>] [--workspace <根>] [--repo <git仓库>] [--json]
 *
 * 输出与 `ledger_today` 工具首行同一格式：
 *   改N 备M | 判断N 记M | 冲突N | 今日事件：有/无
 */
import {
  contextFromArgs, fail, parseArgs, print,
} from './_shared.mjs';
import { todayFirstLine } from '../lib/today.js';

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    print('用法: node plugin/tools/today.mjs [--home <DSH_HOME>] [--workspace <根>] [--repo <仓库>] [--json]');
    return 0;
  }
  const { config, store } = contextFromArgs(opts);
  const line = todayFirstLine(store, config);
  if (opts.json) {
    print(JSON.stringify({ today: store.today(), line }));
  } else {
    print(line);
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  fail(`today.mjs 异常：${error?.message ?? error}`);
}
