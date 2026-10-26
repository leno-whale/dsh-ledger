import path from 'node:path';

import { resolveConfig } from '../lib/config.js';
import { Store } from '../lib/store.js';

/** 三个离线 CLI 共用的参数与路径解析。纯 node 内置模块，不依赖 DSH。 */
export function parseArgs(argv) {
  const opts = {
    home: '', workspace: '', repos: [], apply: false, json: false, help: false, now: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--home':
        opts.home = argv[++i] ?? '';
        break;
      case '--workspace':
        opts.workspace = argv[++i] ?? '';
        break;
      case '--repo':
        opts.repos.push(argv[++i] ?? '');
        break;
      case '--apply':
        opts.apply = true;
        break;
      case '--dry-run':
        opts.apply = false;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--now':
        opts.now = argv[++i] ?? '';
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  opts.repos = opts.repos.filter(Boolean);
  return opts;
}

/** 由参数构造 config/store；--home 同时覆盖 DSH_HOME，供测试隔离。 */
export function contextFromArgs(opts) {
  const raw = {};
  if (opts.home) raw.dshHome = opts.home;
  if (opts.workspace) raw.workspaceRoot = opts.workspace;
  if (opts.repos.length > 0) raw.watchRepos = opts.repos;
  const config = resolveConfig(raw);
  const now = opts.now ? () => new Date(opts.now) : undefined;
  return { config, store: new Store(config, now ? { now } : {}) };
}

export function homeDir(opts) {
  return opts.home ? path.resolve(opts.home) : resolveConfig({}).dshHome;
}

export function stateFile(home) {
  return path.join(home, 'ledger-state.json');
}

export function loadErrorFile(home) {
  return path.join(home, 'ledger-errors.jsonl');
}

export function print(text) {
  process.stdout.write(`${text}\n`);
}

export function fail(text, code = 1) {
  process.stderr.write(`${text}\n`);
  process.exitCode = code;
}
