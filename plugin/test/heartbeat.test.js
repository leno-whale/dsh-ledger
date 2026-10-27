import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-hb-'));
process.env.DSH_HOME = HOME;

const { default: plugin } = await import('../lib/index.js');

function fakeCtx(handlers) {
  return {
    tools: { register: () => () => {}, guard: () => () => {} },
    on: (event, fn) => { handlers[event] = fn; return () => {}; },
    get: () => undefined,
    systemPrompt: { section: () => () => {} },
    effect: () => () => {},
  };
}

test('回合结束时写心跳文件', () => {
  const handlers = {};
  plugin.apply(fakeCtx(handlers), {});
  assert.equal(typeof handlers['agent/turn-stopping'], 'function');
  handlers['agent/turn-stopping']({});
  const hb = JSON.parse(fs.readFileSync(path.join(HOME, 'ledger-heartbeat.json'), 'utf8'));
  assert.ok(hb.at && !Number.isNaN(Date.parse(hb.at)));
  assert.equal(typeof hb.pid, 'number');
});

test('心跳写失败不影响其它段（目录被占也不抛）', () => {
  const handlers = {};
  plugin.apply(fakeCtx(handlers), {});
  const file = path.join(HOME, 'ledger-heartbeat.json');
  fs.rmSync(file, { force: true });
  fs.mkdirSync(file); // 同名目录 → writeFileSync 必失败
  assert.doesNotThrow(() => handlers['agent/turn-stopping']({}));
  fs.rmSync(file, { recursive: true, force: true });
});
