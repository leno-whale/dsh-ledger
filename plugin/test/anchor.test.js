// P1（L₂ 锚）：锚不是事件——说不出「改了什么」就不该进 L₂。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { addAnchor, anchorLine, readAnchors, recentAnchors } from '../lib/anchor.js';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-'));
  return path.join(dir, '自我', '锚.jsonl');
}

test('P1: 一条锚要三样——谁顶的、改了什么，from 可空', () => {
  const file = tmpFile();
  const rec = addAnchor(file, { hit: '主人', changed: '回帖前先去 API 取原文', from: 'B18' });
  assert.equal(rec.kind, 'anchor');
  assert.equal(rec.hit, '主人');
  assert.equal(rec.from, 'B18');
  assert.ok(Date.parse(rec.t) > 0);
  const all = readAnchors(file);
  assert.equal(all.length, 1);
  assert.equal(all[0].changed, '回帖前先去 API 取原文');

  const noFrom = addAnchor(file, { hit: '白饭馆 #109', changed: '把「只递最新一张」写进正文' });
  assert.equal(noFrom.from, null);
  assert.equal(readAnchors(file).length, 2);
});

test('P1: 缺 changed 直接拒——那是事件，不是锚', () => {
  const file = tmpFile();
  assert.throws(() => addAnchor(file, { hit: '主人' }), /changed 不能为空/);
  assert.throws(() => addAnchor(file, { hit: '主人', changed: '   ' }), /changed 不能为空/);
  assert.throws(() => addAnchor(file, { changed: '改了什么' }), /hit 不能为空/);
  assert.equal(readAnchors(file).length, 0);
});

test('P1: 近 7 天过滤 + 新的在前 + 坏行跳过', () => {
  const file = tmpFile();
  const now = Date.parse('2026-10-29T12:00:00.000Z');
  addAnchor(file, { hit: '旧事', changed: '十天前的', t: '2026-10-19T12:00:00.000Z' });
  addAnchor(file, { hit: '前天', changed: '前天的', t: '2026-10-27T12:00:00.000Z' });
  addAnchor(file, { hit: '昨天', changed: '昨天的', t: '2026-10-28T12:00:00.000Z' });
  fs.appendFileSync(file, '{这不是 json}\n', 'utf8');

  const recent = recentAnchors(file, { days: 7, now });
  assert.deepEqual(recent.map((a) => a.hit), ['昨天', '前天']);
  assert.equal(readAnchors(file).length, 3, '坏行跳过，好行全在');
});

test('P1: 注入那一行——没有锚就返回空串，不占行', () => {
  const file = tmpFile();
  assert.equal(anchorLine(file), '');
  addAnchor(file, { hit: '主人', changed: '改文件之前先备份', t: '2026-10-29T10:00:00.000Z' });
  const line = anchorLine(file);
  assert.match(line, /^【近 7 天锚】1 条，最近：改文件之前先备份$/);

  addAnchor(file, { hit: '自己', changed: 'x'.repeat(120), t: '2026-10-29T10:00:01.000Z' });
  assert.match(anchorLine(file), /^【近 7 天锚】2 条，最近：x{60}…$/);
});

test('P1: 同一毫秒写两条时，后写的算「最近」', () => {
  const file = tmpFile();
  const t = '2026-10-29T10:00:00.000Z';
  addAnchor(file, { hit: '先', changed: '先写的那条', t });
  addAnchor(file, { hit: '后', changed: '后写的那条', t });
  assert.match(anchorLine(file), /最近：后写的那条$/);
});
