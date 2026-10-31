import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { countCommitments, extractAssistantText } from '../lib/commitwords.js';

test('承诺 S1: 说「明天」「等会」算承诺，一句一处', () => {
  const r = countCommitments('明天我把那两条回掉。等会再补一行记录。');
  assert.equal(r.count, 2);
});

test('承诺 S2: 假设和否定不算——「如果明天…」不是答应', () => {
  assert.equal(countCommitments('如果明天有空，我就把那条回了。').count, 0);
  assert.equal(countCommitments('明天那条已经回过了。').count, 0);
  assert.equal(countCommitments('别等会了，现在就做。').count, 0);
});

test('承诺 S3: 空文本不报错', () => {
  assert.deepEqual(countCommitments(''), { count: 0, hits: [] });
  assert.deepEqual(countCommitments(null), { count: 0, hits: [] });
});

test('承诺 S4: 从会话日志尾部取出最后一条 assistant 文本', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leno-cw-'));
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  try {
    const lines = [
      JSON.stringify({ type: 'session', id: 'x' }),
      JSON.stringify({ type: 'user/message', data: { text: '你好' } }),
      JSON.stringify({ type: 'assistant/message', data: { text: '明天我再回你。' } }),
    ];
    fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(`${lines.join('\n')}\n`, 'utf8')));
    const text = extractAssistantText(file);
    assert.match(text, /明天我再回你/);
    assert.equal(countCommitments(text).count, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('承诺 S5: 文件不存在 / 不是 zstd → 空串，不抛', () => {
  assert.equal(extractAssistantText('Z:\\nope\\session.v4.jsonl.zstd'), '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leno-cw2-'));
  try {
    const file = path.join(dir, 'x.zstd');
    fs.writeFileSync(file, 'plain text');
    assert.equal(extractAssistantText(file), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
