import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { createInjection } from '../lib/inject.js';
import { createPostExecute, createTurnStopper } from '../lib/gates.js';
import { createTools } from '../lib/tools.js';
import { makeEnv, writeEventFile } from './helpers.js';

/**
 * a）「有改无账」的迟到提醒 + b）`ledger_today` 的「改了没记判断」告警。
 * 这两条的来历：10-27 主人问「插件有没有提醒到你」，答案是**没有**——
 * 它只在「今天账上一笔都没有」时才敲，而写文章那天账上有三十笔。
 */

function turnStats() {
  return { edits: 0, ledger: 0 };
}

test('a) post-execute 只数成功的 write/edit 与 ledger_*', async () => {
  const stats = turnStats();
  const hook = createPostExecute(new WeakMap(), stats);
  const next = async () => ({ kind: 'accept' });

  await hook({ name: 'edit' }, { isError: false }, next);
  await hook({ name: 'write' }, { isError: false }, next);
  assert.equal(stats.edits, 2, 'edit + write 各算一次');
  assert.equal(stats.ledger, 0);

  await hook({ name: 'ledger_today' }, { isError: false }, next);
  await hook({ name: 'ledger_judge' }, { isError: false }, next);
  assert.equal(stats.ledger, 2, 'ledger_* 记进账口，不算改文件');
  assert.equal(stats.edits, 2);

  await hook({ name: 'edit' }, { isError: true }, next);
  await hook({ name: 'bash' }, { isError: false }, next);
  assert.equal(stats.edits, 2, '失败的和无关工具都不加');
  assert.equal(stats.ledger, 2);
});

test('a) 回合结束时把「改了 N、记了 M」落盘，并清零', () => {
  const env = makeEnv();
  try {
    const stats = turnStats();
    stats.edits = 3;
    const stop = createTurnStopper({ store: env.store, config: env.config, stats });
    stop({ agent: { steer() {} }, turn: 7 });

    const state = env.store.turnState();
    assert.equal(state.edits, 3);
    assert.equal(state.ledger, 0);
    assert.equal(typeof state.t, 'string');
    assert.equal(stats.edits, 0, '结算后清零');
    assert.equal(stats.ledger, 0);
  } finally {
    env.cleanup();
  }
});

test('a) 注入段只在「上回合有改无账」时多说一行', () => {
  const env = makeEnv();
  try {
    // 事件文件在、没有未做、没有未结错误 → 正常情况注入段应当是空的。
    writeEventFile(env, env.store.today());
    const inject = createInjection(env.store);
    assert.equal(inject(), '', '一切正常时不注水');

    env.store.saveTurnState({ t: env.store.nowIso(), edits: 2, ledger: 0 });
    const hot = inject();
    assert.match(hot, /上回合：改了2个文件/);
    assert.ok(hot.split('\n').length <= 5, '仍受 5 行上限');

    env.store.saveTurnState({ t: env.store.nowIso(), edits: 2, ledger: 1 });
    assert.equal(inject(), '', '记过一笔账就不再提醒');
  } finally {
    env.cleanup();
  }
});

test('b) ledger_today：改了文件却一条判断没记，要告警', async () => {
  const env = makeEnv();
  try {
    const today = env.store.today();
    env.store.appendManifest({
      path: 'C:\\a.md', kind: 'edit', sha256: '', size: 0, mtime: today,
    });
    writeEventFile(env, today);

    const tools = createTools(env.store, env.config);
    const todayTool = tools.find((tool) => tool.name === 'ledger_today');
    assert.ok(todayTool, '有 ledger_today');
    const out = await todayTool.execute({});
    assert.match(out.text, /没记过一条判断/);

    await tools.find((tool) => tool.name === 'ledger_judge').execute({
      id: 'B2',
      why: '测试用：只为让判断数不为 0',
      who: '没有收件人',
      audience: '没人旁观',
      approach: '接论点',
      verbatim: '原话',
    });
    const after = await todayTool.execute({});
    assert.doesNotMatch(after.text, /没记过一条判断/, '记过一条判断后告警消失');
  } finally {
    env.cleanup();
  }
});

test('a) 没有 stats 时两个钩子照旧工作（向后兼容）', async () => {
  const env = makeEnv();
  try {
    const hook = createPostExecute(new WeakMap());
    const decision = await hook({ name: 'edit' }, { isError: false }, async () => ({ kind: 'accept' }));
    assert.equal(decision.kind, 'accept');

    const stop = createTurnStopper({ store: env.store, config: env.config });
    stop({ agent: { steer() {} }, turn: 1 });
    assert.equal(fs.existsSync(env.store.turnStateFile), false, '不传 stats 就不写状态文件');
  } finally {
    env.cleanup();
  }
});
