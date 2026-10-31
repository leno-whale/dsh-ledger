// 幽灵会话（2026-10-31）
//
// 那天注入段报「【交接】刚裁过（4290→175 KB）」，其实我没被裁过。
// 175 KB 是 `~\.dsh\profiles\desktop` 下的一份旧会话——10-28 主人从宿主目录
// 启动 GUI，问「你好，你是Leno吗」，那份会话被建在了插件安装目录里。
//
// 教训：**宿主装插件的地方不是谁的工作区**，从那儿长出来的会话不能当我的。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { encodeProjectDir, findSessionFile, isHostProfileDir, readSession } from '../lib/sessionwatch.js';
import { makeEnv } from './helpers.js';

function plant(dshHome, cwd, name, bytes, mtimeMs) {
  const dir = path.join(dshHome, 'sessions', encodeProjectDir(cwd), name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
  if (mtimeMs) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

test('幽灵 S1: isHostProfileDir 认得出宿主目录，不误伤工作区', () => {
  assert.equal(isHostProfileDir('C:\\Users\\X\\.dsh\\profiles\\desktop'), true);
  assert.equal(isHostProfileDir('C:/Users/X/.dsh/profiles/desktop'), true);
  assert.equal(isHostProfileDir('C:\\Users\\X\\.dsh\\whale-work'), false);
  assert.equal(isHostProfileDir('F:\\agent expore'), false);
});

// 真实形状：C:\Users\<user>\.dsh\profiles\desktop（有那个点）
const HOST_DIR = 'C:\\Users\\HUAWEI\\.dsh\\profiles\\desktop';

test('幽灵 S2: 宿主目录里的会话再新，也不能当成我的', () => {
  const env = makeEnv();
  try {
    // 故意做成「刚写过」——新鲜度挡不住它，只有白名单能挡
    plant(env.dshHome, HOST_DIR, 'ghost', 175 * 1024, Date.now() - 60 * 1000);
    const got = readSession(env.dshHome, HOST_DIR);
    assert.equal(got, null, '宿主目录的会话不该被读出来');
  } finally {
    env.cleanup();
  }
});

test('幽灵 S3: 工作区里有会话、宿主目录也有时，取工作区那份', () => {
  const env = makeEnv();
  try {
    plant(env.dshHome, HOST_DIR, 'ghost', 175 * 1024, Date.now() - 60 * 1000);
    plant(env.dshHome, env.workspaceRoot, 'bili-whale', 900 * 1024, Date.now() - 120 * 1000);
    const got = readSession(env.dshHome, HOST_DIR, env.workspaceRoot);
    assert.ok(got);
    assert.equal(Math.round(got.bytes / 1024), 900);
    assert.equal(findSessionFile(env.dshHome, env.workspaceRoot).name, 'bili-whale');
  } finally {
    env.cleanup();
  }
});
