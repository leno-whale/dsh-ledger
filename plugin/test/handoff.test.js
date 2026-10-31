// 会话闸 + 交接信（0.6.10）
//
// 两条要守住的东西：
// 1. 闸只 stat 字节，不解压 —— 一旦有人把它改成「读轮数」，这里会先红；
// 2. 交接信是文件，不是记忆 —— letter 落骨架、reply 追加在最新那封末尾。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  GATE_BYTES, encodeProjectDir, findNewestSession, findSessionFile, readSession, sessionLine, gateLine, trimmedLine,
} from '../lib/sessionwatch.js';
import { createInjection } from '../lib/inject.js';
import { createTools } from '../lib/tools.js';
import { makeEnv, toolByName, writeWorkspaceFile } from './helpers.js';

function build(env) {
  return new Map(createTools(env.store, env.config).map((tool) => [tool.name, tool]));
}

/** 在假的 dshHome 里造一个会话日志，返回它的路径 */
function plantSession(dshHome, cwd, name, bytes, mtimeMs) {
  const dir = path.join(dshHome, 'sessions', encodeProjectDir(cwd), name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
  if (mtimeMs) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

test('会话闸 S1: 项目目录编码 `C:\\A\\b` → `--C-A-b--`', () => {
  assert.equal(encodeProjectDir('C:\\Users\\HUAWEI\\.dsh\\whale-work'), '--C-Users-HUAWEI-.dsh-whale-work--');
  assert.equal(encodeProjectDir('F:\\agent expore'), '--F-agent expore--');
});

test('会话闸 S2: 多个会话取 mtime 最新的那个；读不到返回 null', () => {
  const env = makeEnv();
  try {
    const cwd = 'C:\\work';
    plantSession(env.dshHome, cwd, 'old', 100, 1_000_000);
    const fresh = plantSession(env.dshHome, cwd, 'fresh', 4096, 2_000_000);
    const found = findSessionFile(env.dshHome, cwd);
    assert.equal(found.file, fresh);
    assert.equal(found.bytes, 4096);
    assert.equal(findSessionFile(env.dshHome, 'C:\\nope'), null);
  } finally {
    env.cleanup();
  }
});

test('会话闸 S3: readSession 认 cwd 命中的那份；cwd 全不中时兜底仍在写的那份', () => {
  const env = makeEnv();
  try {
    plantSession(env.dshHome, 'C:\\real-ws', 'bili-whale', 2048);
    assert.equal(readSession(env.dshHome, 'C:\\elsewhere', 'C:\\real-ws').bytes, 2048);
    // 2026-10-31：cwd 一个都不中，也不许报 0——刚写过的会话就是当前会话
    const fallback = readSession(env.dshHome, 'C:\\elsewhere');
    assert.equal(fallback.bytes, 2048);
    assert.equal(fallback.fromCwd, false);
  } finally {
    env.cleanup();
  }
});

test('会话闸 S4: 三行文案——常态、到闸写成动作、刚裁过', () => {
  const small = { bytes: 300 * 1024 };
  const big = { bytes: GATE_BYTES };
  assert.equal(sessionLine(small), '【会话】300 KB / 闸 10000 KB');
  const gateKb = Math.round(GATE_BYTES / 1024);
  assert.match(gateLine(big), new RegExp(`^【会话·到闸】${gateKb} KB ≥ ${gateKb} KB → 这一轮先说三件：`));
  assert.match(gateLine(big), /trim-session --turns=30 --install/);
  assert.match(gateLine(big), /ledger_handoff letter/);
  assert.match(gateLine(big), /schedule_create after_seconds=300/);
  // 刚裁过：掉到 70% 以下才提醒
  assert.match(trimmedLine(800 * 1024, { bytes: 400 * 1024 }), /^【交接】刚裁过（800→400 KB）/);
  assert.equal(trimmedLine(800 * 1024, { bytes: 600 * 1024 }), '');
  assert.equal(trimmedLine(0, small), '');
});

test('会话闸 S5: ledger_handoff status 报字节；没有会话时说实话（不报 0）', async () => {
  const env = makeEnv();
  try {
    const tool = toolByName(build(env), 'ledger_handoff');
    const none = await tool.execute({ action: 'status' });
    assert.equal(none.ok, true);
    assert.match(none.text, /读不到会话日志/);

    plantSession(env.dshHome, env.workspaceRoot, 'bili-whale', 300 * 1024);
    const hit = await tool.execute({ action: 'status' });
    assert.equal(hit.text, '会话 300 KB / 闸 10000 KB');
  } finally {
    env.cleanup();
  }
});

test('会话闸 S6: letter 落骨架到 自我\\归档，reply 追加在最新那封末尾', async () => {
  const env = makeEnv();
  try {
    const tool = toolByName(build(env), 'ledger_handoff');
    const letter = await tool.execute({ action: 'letter', cutTurns: 30, note: '闸 10000 KB' });
    assert.equal(letter.ok, true);

    const dir = path.join(env.workspaceRoot, '自我', '归档');
    const files = fs.readdirSync(dir).filter((n) => n.startsWith('给裁后的我-'));
    assert.equal(files.length, 1);
    const body = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    assert.match(body, /准备裁到 30 轮/);
    assert.match(body, /## 一、你可能不记得的三件/);
    assert.match(body, /## 二、没做完的事/);
    assert.match(body, /对话会被裁，文件不会。/);
    assert.match(body, /闸 10000 KB\n$/);

    const reply = await tool.execute({ action: 'reply' });
    assert.equal(reply.ok, true);
    const after = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    assert.match(after, /## 回信（/);
    assert.match(after, /- \*\*我不认的\*\*（指到哪句、哪个数）：/);
    assert.equal((after.match(/## 回信（/g) ?? []).length, 1);
  } finally {
    env.cleanup();
  }
});

test('会话闸 S7: 没有信时 reply 说清楚先 letter，不静默造一封', async () => {
  const env = makeEnv();
  try {
    const tool = toolByName(build(env), 'ledger_handoff');
    const reply = await tool.execute({ action: 'reply' });
    assert.equal(reply.ok, false);
    assert.match(reply.text, /没有「给裁后的我-\*\.md」/);
  } finally {
    env.cleanup();
  }
});

test('会话闸 S8: cwd 对不上时兜底取「最近还在写」的那份；旧的不认', () => {
  const env = makeEnv();
  try {
    // 插件进程的 cwd 常是宿主目录，所以这里故意用一个不存在的 cwd
    plantSession(env.dshHome, 'C:\\other-project', 'someone', 1024, Date.now() - 5 * 60 * 1000);
    const found = findNewestSession(env.dshHome);
    assert.ok(found, '30 分钟内写过的会话应该被兜底认出来');
    assert.equal(found.bytes, 1024);

    // 只剩很旧的会话时，宁可不报，也不拿别人的会话凑数
    const oldMs = Date.now() - 3 * 60 * 60 * 1000;
    fs.utimesSync(found.file, oldMs / 1000, oldMs / 1000);
    assert.equal(findNewestSession(env.dshHome), null);
  } finally {
    env.cleanup();
  }
});

test('会话闸 S10: 旧仪器陷阱——cwd 里那份是十小时前的旧会话，真在写的那份在别处', () => {
  const env = makeEnv();
  try {
    const now = Date.now();
    // GUI 进程的 cwd 是 profiles\desktop：那里躺着一份 175 KB 的旧会话
    plantSession(env.dshHome, 'C:\\Users\\HUAWEI\\.dsh\\profiles\\desktop', 'old', 175 * 1024, now - 10 * 3600 * 1000);
    // 真正在写的是 whale-work 那个项目里的一份，刚写过
    plantSession(env.dshHome, 'C:\\Users\\HUAWEI\\.dsh\\whale-work', 'bili-whale', 900 * 1024, now - 5000);

    const picked = readSession(env.dshHome, 'C:\\Users\\HUAWEI\\.dsh\\profiles\\desktop');
    assert.equal(picked.bytes, 900 * 1024, '应该取最近还在写的那份，而不是 cwd 里那份旧的');
    assert.equal(picked.name, 'bili-whale');
  } finally {
    env.cleanup();
  }
});

test('会话闸 S9: 注入段里真的出现【会话】那一行，且不超过 5 行（重启后你该看到的那行）', () => {
  const env = makeEnv();
  try {
    plantSession(env.dshHome, env.workspaceRoot, 'bili-whale', 700 * 1024);
    const section = createInjection(env.store, env.config)();
    assert.match(section, /【会话】700 KB \/ 闸 10000 KB/);
    assert.ok(section.split('\n').length <= 5);

    // 到闸时置顶换成动作句（闸 10000 KB，所以要造 10100 KB 才算到）
    plantSession(env.dshHome, env.workspaceRoot, 'bili-whale', 10100 * 1024);
    const hot = createInjection(env.store, env.config)();
    assert.match(hot.split('\n')[0], /^【会话·到闸】/);
  } finally {
    env.cleanup();
  }
});

test('会话闸 S11: 有表时注入段真的出现【窗】行（0.6.13 漏了 import path，窗行一直是空的）', () => {
  const env = makeEnv();
  try {
    // 表放在 workspaceRoot 下：注入段默认从 <ws>\\自我\\时间表.json 读
    const table = {
      interact: { weekday: [['12:00', '14:00'], ['18:00', '23:30']], weekend: [['08:00', '23:30']] },
      wake: { daily: [['01:00', '03:00']] },
      quota: { weekday: 6, weekend: 10 },
    };
    writeWorkspaceFile(env, '自我/时间表.json', JSON.stringify(table));
    const section = createInjection(env.store, env.config)();
    assert.match(section, /【窗】/, `注入段里该有窗行，实际是：${section}`);
    assert.match(section, /额度 (6|10)/);
  } finally {
    env.cleanup();
  }
});