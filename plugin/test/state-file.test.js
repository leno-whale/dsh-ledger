import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { stateFileOf } from '../lib/config.js';
import { createPostExecute, createTurnStopper } from '../lib/gates.js';
import { createInjection } from '../lib/inject.js';
import { makeEnv, writeWorkspaceFile } from './helpers.js';

function execFor(name, args) {
  return { name, arguments: args };
}

test('v0.5.3: 只有这四类「状态类文件」算命中', () => {
  assert.equal(stateFileOf('C:\\Users\\HUAWEI\\.dsh\\bili-whale.config.json'), 'bili-whale.config.json');
  assert.equal(stateFileOf('C:/Users/HUAWEI/.dsh/profiles/desktop/package.json'), 'package.json');
  assert.equal(
    stateFileOf('F:\\agent expore\\plugins\\dsh-bili-whale\\lib\\scheduler.js'),
    'scheduler.js',
  );
  assert.equal(stateFileOf('F:/agent expore/dsh-leno-ledger/plugin/package.json'), 'package.json');
  // 普通文件不算
  assert.equal(stateFileOf('C:\\Users\\HUAWEI\\.dsh\\whale-diary.md'), '');
  assert.equal(stateFileOf(path.join('a', 'b', 'note.json')), '');
  assert.equal(stateFileOf(''), '');
  assert.equal(stateFileOf(null), '');
});

test('v0.5.3: write/edit 状态类文件时记下来，回合结束写进 turn state', async () => {
  const env = makeEnv();
  try {
    const stats = { edits: 0, ledger: 0, stateFiles: [] };
    const post = createPostExecute(new WeakMap(), stats);

    await post(execFor('edit', { file_path: 'C:\\x\\bili-whale.config.json' }), { content: [] }, async () => ({
      kind: 'accept',
    }));
    await post(execFor('edit', { file_path: 'C:\\x\\whale-diary.md' }), { content: [] }, async () => ({
      kind: 'accept',
    }));
    // 失败的不算
    await post(
      execFor('edit', { file_path: 'C:\\x\\profiles\\desktop\\package.json' }),
      { isError: true },
      async () => ({ kind: 'accept' }),
    );

    assert.equal(stats.edits, 2);
    assert.deepEqual(stats.stateFiles, ['bili-whale.config.json'], '只收状态类、且只收成功的那次');

    const stopper = createTurnStopper({ store: env.store, config: env.config, stats });
    stopper({ agent: null, turn: 't1' });

    const turn = env.store.turnState();
    assert.deepEqual(turn.stateFiles, ['bili-whale.config.json']);
    assert.equal(stats.stateFiles.length, 0, '回合结束就清零');
  } finally {
    env.cleanup();
  }
});

test('v0.5.3: 注入段提醒「状态页更新了吗」，一天只提醒一次', () => {
  const env = makeEnv();
  try {
    const today = env.store.today();
    writeWorkspaceFile(env, `接口/说/${today}-01.md`, '# 有事件');
    const inject = createInjection(env.store);

    assert.equal(inject(), '', '一切正常时不注水');

    env.store.saveTurnState({
      t: env.store.nowIso(),
      edits: 1,
      ledger: 1,
      stateFiles: ['bili-whale.config.json'],
    });

    const hot = inject();
    assert.match(hot, /改过状态类文件（bili-whale\.config\.json）/);
    assert.match(hot, /状态页更新了吗/);
    assert.ok(hot.split('\n').length <= 5, '仍受 5 行上限');

    assert.equal(inject(), '', '同一天不提醒第二次');
  } finally {
    env.cleanup();
  }
});
