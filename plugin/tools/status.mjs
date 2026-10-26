#!/usr/bin/env node
/**
 * status.mjs — 账房自检（不需要模型上下文）。
 *
 * 用法：
 *   node plugin/tools/status.mjs [--home <DSH_HOME>] [--workspace <根>] [--repo <git仓库>] [--json]
 *
 * 打印：①模块能否 import ②ledger-state.json 是否存在及内容 ③最近一条账
 *       ④备份目录文件数 ⑤今日「改N 备M」。正常退出 0，异常 1。
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  contextFromArgs, fail, homeDir, parseArgs, print, stateFile,
} from './_shared.mjs';
import { latestLedgerEntry, todayFirstLine } from '../lib/today.js';

function walkFiles(dir, out = []) {
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of names) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    print('用法: node plugin/tools/status.mjs [--home <DSH_HOME>] [--workspace <根>] [--repo <仓库>] [--json]');
    return 0;
  }

  const report = {
    module: { ok: false, version: '', error: '' },
    state: { path: '', exists: false, content: null, error: '' },
    latest: null,
    backups: { root: '', files: 0, error: '' },
    today: { line: '', error: '' },
  };

  try {
    const mod = await import(new URL('../lib/index.js', import.meta.url).href);
    report.module.ok = true;
    report.module.version = String(mod.VERSION ?? mod.default?.version ?? '');
  } catch (error) {
    report.module.error = String(error?.message ?? error);
  }

  const home = homeDir(opts);
  const file = stateFile(home);
  report.state.path = file;
  if (fs.existsSync(file)) {
    report.state.exists = true;
    try {
      report.state.content = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      report.state.error = String(error?.message ?? error);
    }
  }

  try {
    const { config, store } = contextFromArgs({ ...opts, home });
    report.backups.root = config.backupRoot;
    report.backups.files = walkFiles(config.backupRoot).length;
    report.latest = latestLedgerEntry(store);
    report.today.line = todayFirstLine(store, config);
  } catch (error) {
    report.backups.error = String(error?.message ?? error);
    report.today.error = String(error?.message ?? error);
  }

  if (opts.json) {
    report.ok = report.module.ok && report.state.exists
      && Object.values(report.state.content?.segments ?? {}).every((s) => s?.ok !== false);
    print(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }

  print(`账房 v${report.module.version || '?'} 自检`);
  print(report.module.ok
    ? '1) 模块 import：OK'
    : `1) 模块 import：失败 —— ${report.module.error}`);

  if (!report.state.exists) {
    print(`2) state：不存在（${file}）——插件没有走完 apply，或还没加载过`);
  } else if (report.state.error) {
    print(`2) state：存在但读不懂（${file}）—— ${report.state.error}`);
  } else {
    const segments = report.state.content?.segments ?? {};
    const parts = Object.entries(segments).map(([name, value]) => `${name}=${value?.ok === false ? 'FAIL' : 'ok'}`);
    print(`2) state：${file}`);
    print(`   version=${report.state.content?.version ?? '?'} loadedAt=${report.state.content?.loadedAt ?? '?'} pid=${report.state.content?.pid ?? '?'}`);
    print(`   segments: ${parts.join(' ') || '(空)'}`);
    for (const [name, value] of Object.entries(segments)) {
      if (value?.ok === false) print(`   ✖ ${name}: ${value.error ?? '未知错误'}`);
    }
  }

  if (report.latest) {
    print(`3) 最近一条账：${report.latest.t ?? '?'} [${report.latest.type}] ${report.latest.summary}`);
  } else {
    print('3) 最近一条账：（无）');
  }
  print(`4) 备份文件：${report.backups.files} 个（${report.backups.root || '未解析'}）`);
  print(`5) 今日：${report.today.line || `（算不出：${report.today.error}）`}`);

  const segmentsOk = report.state.content?.segments
    ? Object.values(report.state.content.segments).every((s) => s?.ok !== false)
    : false;
  return report.module.ok && report.state.exists && segmentsOk ? 0 : 1;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  fail(`status.mjs 异常：${error?.message ?? error}`);
});
