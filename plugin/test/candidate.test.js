// P5（𝔹₂ 候选池）：新听来的一句话先排队，出现两次或带具体反例才升格。
// 覆盖 docs/theory/一进一出-候选池与冷层.md 的 T1/T2/T3/T4/T7。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { addCand, candFile, candidateDir, isReady, listCand, markPromoted, readCand } from '../lib/candidates.js';

function tmpCfg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cand-'));
  return { dshHome: dir, workspaceRoot: null, candidateDir: path.join(dir, '自我', '候选') };
}

test('P5 T1: 一条新听来的话先进候选，seen=1，不算 ready', () => {
  const cfg = tmpCfg();
  const r = addCand(cfg, { id: 'B90', title: '测试判据', body: '照它做会更好', src: '#1', today: '2026-10-29' });
  assert.equal(r.created, true);
  assert.equal(r.seen, 1);
  assert.equal(r.ready, false, '一次就 ready 等于没有排队');
  const c = readCand(cfg, 'B90');
  assert.equal(c.seen, 1);
  assert.equal(c.first, '2026-10-29');
  assert.equal(c.promoted, false);
});

test('P5 T2: 第二次出现 → seen=2 且 ready；旧内容逐字不动（只追加）', () => {
  const cfg = tmpCfg();
  addCand(cfg, { id: 'B91', title: 'x', body: '原来的正文', src: '#1', today: '2026-10-29' });
  const before = fs.readFileSync(candFile(cfg, 'B91'), 'utf8');
  const beforeBody = before.split(/\r?\n/).filter((l) => l.trim() === '原来的正文');
  assert.equal(beforeBody.length, 1);

  const r = addCand(cfg, { id: 'B91', title: 'x', body: '原来的正文', src: '#2', today: '2026-10-30' });
  assert.equal(r.seen, 2);
  assert.equal(r.ready, true);

  const after = fs.readFileSync(candFile(cfg, 'B91'), 'utf8');
  assert.ok(after.startsWith(before.replace(/\n$/, '')), '原有内容必须原样留在前头');
  assert.equal(after.split(/\r?\n/).filter((l) => l.trim() === '原来的正文').length, 1, '正文不许被复制一遍');
  assert.match(after, /第 2 次：2026-10-30/);
});

test('P5 T3: 同一天同一 ref 只 +1（幂等，防止一句话顶两次就升格）', () => {
  const cfg = tmpCfg();
  addCand(cfg, { id: 'B92', title: 'y', body: 'b', src: '#7', today: '2026-10-29' });
  const a = addCand(cfg, { id: 'B92', title: 'y', body: 'b', src: '#7', ref: '#7', today: '2026-10-29' });
  assert.equal(a.idempotent, true);
  assert.equal(a.seen, 1);
  assert.equal(readCand(cfg, 'B92').seen, 1);
});

test('P5 T4: 候选文件坏了不崩，listCand 跳过它', () => {
  const cfg = tmpCfg();
  addCand(cfg, { id: 'B93', title: 'z', body: 'b', today: '2026-10-29' });
  const bad = candFile(cfg, 'B94');
  fs.writeFileSync(bad, '\u0000\u0000 坏文件', 'utf8');
  const rows = listCand(cfg);
  assert.ok(rows.some((r) => r.id === 'B93'), '好的还在');
  assert.equal(readCand(cfg, 'B94')?.seen ?? null, null, '坏文件读成 null，不抛');
});

test('P5 T7 反例: seen=1 且无反例 → 不许 ready；带 evidence 就许', () => {
  const cfg = tmpCfg();
  addCand(cfg, { id: 'B95', title: 'w', body: 'b', today: '2026-10-29' });
  const c = readCand(cfg, 'B95');
  assert.equal(isReady(c, ''), false);
  assert.equal(isReady(c, '照它做，X 出了错'), true, '带具体反例可以直接升格');
});

test('P5: 升格后候选标 promoted，不再重复升格', () => {
  const cfg = tmpCfg();
  addCand(cfg, { id: 'B96', title: 'v', body: 'b', today: '2026-10-29' });
  assert.equal(markPromoted(cfg, 'B96', '2026-10-30T00:00:00.000Z'), true);
  const c = readCand(cfg, 'B96');
  assert.equal(c.promoted, true);
  assert.equal(markPromoted(cfg, 'B96', '2026-10-30T01:00:00.000Z'), false, '第二次标记应为 false');
});

test('P5: 目录随 workspaceRoot 落位；id 形状必须合法', () => {
  assert.equal(
    candidateDir({ workspaceRoot: path.join('C:', 'ws') }),
    path.join('C:', 'ws', '自我', '候选'),
  );
  assert.throws(() => addCand(tmpCfg(), { id: 'X1', body: 'b' }), /id 必须是/);
});
