// 指定会话触发（2026-10-31）
//
// 0.6.15 把「宿主目录里的会话」挡在外面，但「猜哪一份会话是我的」这件事还在：
// 同一个宿主进程里开着几个会话时，账房会给每个会话都写 L1、都敲收工闸。
// 主人 2026-10-31 定：改成**按指定会话触发**——配置里点名，没点名的会话一声不响。
//
// 会话 id 的来源核对过宿主源码：`assembleContextFor(agent)` 等于 `{ agent, scope: agent }`，
// 组装时 `section.text(context)` 收到的就是它，`agent.session.id` 即会话 id；
// `agent/turn-stopping` 的 payload 里也有 `agent`。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createInjection } from '../lib/inject.js';
import { createTurnStopper } from '../lib/gates.js';
import { describeTargets, isTargeted, matchSession, sessionIdOf } from '../lib/session-target.js';
import { makeEnv } from './helpers.js';

test('点名 S1: 从 context / payload / agent 里都能挖出会话 id', () => {
  assert.equal(sessionIdOf({ agent: { session: { id: 'a-1' } } }), 'a-1');
  assert.equal(sessionIdOf({ agent: { sessionId: 'a-2' } }), 'a-2');
  assert.equal(sessionIdOf({ agent: { id: 'a-3' } }), 'a-3');
  assert.equal(sessionIdOf({ session: { id: 'a-4' } }), 'a-4');
  assert.equal(sessionIdOf('a-5'), 'a-5');
  assert.equal(sessionIdOf({}), '');
  assert.equal(sessionIdOf(undefined), '');
});

test('点名 S2: 精确比 / 通配 / 空值', () => {
  assert.equal(matchSession('abc', 'abc'), true);
  assert.equal(matchSession('abc', 'abd'), false);
  assert.equal(matchSession('main-1', 'main-*'), true);
  assert.equal(matchSession('main-1', '*-1'), true);
  assert.equal(matchSession('main-1', 'other-*'), false);
  assert.equal(matchSession('', 'main-*'), false);
  assert.equal(matchSession('abc', ''), false);
});

test('点名 S3: 空名单＝照旧全管；认不出默认管、可配成不管', () => {
  assert.equal(isTargeted([], 'any'), true);
  assert.equal(isTargeted(undefined, 'any'), true);
  assert.equal(isTargeted(['main-*'], 'main-7'), true);
  assert.equal(isTargeted(['main-*'], 'other'), false);
  assert.equal(isTargeted(['main-*'], ''), true, '认不出时默认照旧管');
  assert.equal(isTargeted(['main-*'], '', { unknown: 'skip' }), false, '认不出时可选一律不管');
  assert.equal(describeTargets([]), '全部会话');
  assert.equal(describeTargets(['a', 'b']), 'a, b');
});

test('点名 S4: 注入段只给点名的会话', () => {
  const env = makeEnv({ config: { sessions: ['main-*'] } });
  try {
    const inject = createInjection(env.store, env.config);
    const hit = inject({ agent: { session: { id: 'main-1' } } });
    const miss = inject({ agent: { session: { id: 'someone-else' } } });
    assert.ok(hit.includes('【账房】'), '点名的会话该看到账');
    assert.equal(miss, '', '没点名的会话一个字都不该看到');
  } finally {
    env.cleanup();
  }
});

test('点名 S5: 收工闸对没点名的会话一声不响（不 steer、不写 L1）', () => {
  const env = makeEnv({ config: { sessions: ['main'] } });
  try {
    const stopper = createTurnStopper({ store: env.store, config: env.config });
    let steered = 0;
    const agent = { session: { id: 'someone-else' }, steer() { steered += 1; } };
    stopper({ agent, turn: 't1' });
    assert.equal(steered, 0, '不该 steer 别人的会话');
    const l1Dir = path.join(env.workspaceRoot, '自我', 'L1');
    const files = fs.existsSync(l1Dir) ? fs.readdirSync(l1Dir) : [];
    assert.equal(files.length, 0, '不该给别人的会话写 L1');
  } finally {
    env.cleanup();
  }
});

test('点名 S6: 点名的会话照旧敲收工闸（证明闸没被关死）', () => {
  const env = makeEnv({ config: { sessions: ['main'] } });
  try {
    const stopper = createTurnStopper({ store: env.store, config: env.config });
    let steered = 0;
    const agent = { session: { id: 'main' }, steer() { steered += 1; } };
    stopper({ agent, turn: 't1' });
    assert.equal(steered, 1, '点名的会话该被敲一次');
    const l1Dir = path.join(env.workspaceRoot, '自我', 'L1');
    assert.ok(fs.existsSync(l1Dir) && fs.readdirSync(l1Dir).length > 0, '点名的会话该有 L1 流水');
  } finally {
    env.cleanup();
  }
});

test('点名 S7: sessionUnknown=skip 时，认不出会话的调用一律不管', () => {
  const env = makeEnv({ config: { sessions: ['main'], sessionUnknown: 'skip' } });
  try {
    const inject = createInjection(env.store, env.config);
    assert.equal(inject(), '', '没有 context 就认不出会话，配了 skip 就不该注入');
    const stopper = createTurnStopper({ store: env.store, config: env.config });
    let steered = 0;
    stopper({ agent: { steer() { steered += 1; } }, turn: 't1' });
    assert.equal(steered, 0);
  } finally {
    env.cleanup();
  }
});
