import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULTS, matchIgnore, resolveConfig, systemTimeZone } from '../lib/config.js';
import { createBackupGuard } from '../lib/gates.js';
import { Store } from '../lib/store.js';
import { FIXED_NOW } from './helpers.js';

function tmpHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-cfg-'));
  const home = path.join(root, 'dsh');
  fs.mkdirSync(home, { recursive: true });
  return { root, home, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('v0.3/默认：没有任何配置时只备份+记账，数据放 <dshHome>/ledger', () => {
  const t = tmpHome();
  try {
    const cfg = resolveConfig({ dshHome: t.home });
    assert.equal(cfg.dataDir, path.join(t.home, 'ledger'));
    assert.equal(cfg.backupRoot, path.join(t.home, 'backup'));
    assert.equal(cfg.sayDir, '');
    assert.equal(cfg.rulesDir, '');
    assert.equal(cfg.workspaceRoot, '');
    assert.equal(cfg.autoBackup, true);
    assert.equal(cfg.maxSkipsPerDay, 3);
    assert.equal(cfg.inject, true);
    assert.equal(cfg.timeZone, systemTimeZone());
    assert.ok(cfg.maxBackupBytes > 0);
  } finally {
    t.cleanup();
  }
});

test('v0.3/兼容：<dshHome> 根上已有老账时，数据留在根上，不搬家', () => {
  const t = tmpHome();
  try {
    fs.writeFileSync(path.join(t.home, 'whale-backup-manifest.jsonl'), '', 'utf8');
    const cfg = resolveConfig({ dshHome: t.home });
    assert.equal(cfg.dataDir, t.home);
    assert.equal(cfg.beliefsFile, path.join(t.home, 'whale-beliefs.md'));
  } finally {
    t.cleanup();
  }
});

test('v0.3/兼容：给了 workspaceRoot 就按 接口/说、接口/规矩 推出（老的个人布局）', () => {
  const t = tmpHome();
  try {
    const ws = path.join(t.root, 'ws');
    const cfg = resolveConfig({ dshHome: t.home, workspaceRoot: ws });
    assert.equal(cfg.sayDir, path.join(ws, '接口', '说'));
    assert.equal(cfg.rulesDir, path.join(ws, '接口', '规矩'));
  } finally {
    t.cleanup();
  }
});

test('v0.3/显式路径优先于推出的路径', () => {
  const t = tmpHome();
  try {
    const say = path.join(t.root, 'my-say');
    const cfg = resolveConfig({ dshHome: t.home, workspaceRoot: path.join(t.root, 'ws'), sayDir: say });
    assert.equal(cfg.sayDir, say);
  } finally {
    t.cleanup();
  }
});

test('v0.3/忽略清单：密钥与依赖目录不放行备份', () => {
  const pats = DEFAULTS.ignore;
  assert.equal(matchIgnore('/x/y/.env', pats), true);
  assert.equal(matchIgnore('/x/y/.env.local', pats), true);
  assert.equal(matchIgnore('/repo/node_modules/a/b.js', pats), true);
  assert.equal(matchIgnore('/repo/.git/config', pats), true);
  assert.equal(matchIgnore('/repo/server.pem', pats), true);
  assert.equal(matchIgnore('/repo/.npmrc', pats), true);
  assert.equal(matchIgnore('/repo/notes.txt', pats), false);
});

test('v0.3/闸：忽略清单里的文件不备份也不拦', () => {
  const t = tmpHome();
  try {
    const cfg = resolveConfig({ dshHome: t.home, timeZone: 'Asia/Shanghai' });
    const store = new Store(cfg, { now: FIXED_NOW });
    store.ensureDirs();
    const guard = createBackupGuard({ store, config: cfg, notes: new Map() });

    const file = path.join(t.root, '.env');
    fs.writeFileSync(file, 'SECRET=1\n', 'utf8');

    const verdict = guard({ name: 'write', arguments: { file_path: file } });
    assert.equal(verdict, undefined, '忽略清单里的文件应放行');
    assert.equal(
      store.manifestRows().filter((r) => r.path === file).length,
      0,
      '不应在 manifest 里留下记录',
    );
  } finally {
    t.cleanup();
  }
});

test('v0.3/闸：超过 maxBackupBytes 的文件不备份也不拦', () => {
  const t = tmpHome();
  try {
    const cfg = resolveConfig({ dshHome: t.home, timeZone: 'Asia/Shanghai', maxBackupBytes: 8 });
    const store = new Store(cfg, { now: FIXED_NOW });
    store.ensureDirs();
    const guard = createBackupGuard({ store, config: cfg, notes: new Map() });

    const file = path.join(t.root, 'big.txt');
    fs.writeFileSync(file, 'x'.repeat(64), 'utf8');

    assert.equal(guard({ name: 'write', arguments: { file_path: file } }), undefined);
    assert.equal(store.manifestRows().filter((r) => r.kind === 'backup').length, 0);
  } finally {
    t.cleanup();
  }
});

test('v0.3/收工闸：没配 sayDir 时永远不 steer', async () => {
  const t = tmpHome();
  try {
    const cfg = resolveConfig({ dshHome: t.home, timeZone: 'Asia/Shanghai' });
    const store = new Store(cfg, { now: FIXED_NOW });
    store.ensureDirs();

    const { createTurnStopper } = await import('../lib/gates.js');
    const stop = createTurnStopper({ store, config: cfg });
    let steered = 0;
    const agent = { steer() { steered += 1; } };
    stop({ agent, turn: 't1' });
    assert.equal(steered, 0, '默认配置下不该 steer');
  } finally {
    t.cleanup();
  }
});
