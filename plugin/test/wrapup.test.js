import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkWrapup, section, talkCount, threeMomentOf, todayPosts } from '../lib/wrapup.js';

function tmpdir() {
  // 沙箱里 os.tmpdir() 可能 EPERM（mkdtemp 被拒），退到仓库内的临时目录。
  const base = process.env.LENO_TEST_TMP || path.join(process.cwd(), '.tmp-test');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, 'wrapup-'));
}

function writePost(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body, 'utf8');
}

const POST_WITH_PLACEHOLDER = `# 半座城

正文两行。
## 三时刻
- 原计划落笔：2026-11-01 09:30
- 预期兑现：（未定／日期／永不）
- 实际兑现：2026-11-01 09:32
- 被拦：0 次 / 拆句：0 处 / 字数差：0 字
`;

const POST_WITH_TRUTH = POST_WITH_PLACEHOLDER.replace('（未定／日期／永不）', '10:00 前有人回');

test('section 取到最后一段时不能只取第一行（m 模式下 $ 会匹配任意行尾）', () => {
  // 这个 bug 在 affect/p3.mjs 里真实发生过：段体只拿到「原计划落笔」那一行。
  const body = section(POST_WITH_PLACEHOLDER, '三时刻');
  assert.match(body, /预期兑现/);
  assert.match(body, /被拦/);
});

test('section 遇到下一个 ## 就停', () => {
  const text = '## 三时刻\n- 预期兑现：真值\n\n## 别的\n- 不应该被读到\n';
  const body = section(text, '三时刻');
  assert.match(body, /预期兑现/);
  assert.ok(!body.includes('不应该被读到'));
});

test('threeMomentOf：占位符算没填，真值算填了，没段落算没有', () => {
  assert.equal(threeMomentOf(POST_WITH_PLACEHOLDER).filled, false);
  assert.equal(threeMomentOf(POST_WITH_TRUTH).filled, true);
  assert.equal(threeMomentOf('# 只有正文\n').hasSection, false);
});

test('todayPosts 只挑当天的 N 号文件', () => {
  const dir = tmpdir();
  writePost(dir, '2026-11-01-01.md', POST_WITH_TRUTH);
  writePost(dir, '2026-11-01-02.md', POST_WITH_TRUTH);
  writePost(dir, '2026-10-31-09.md', POST_WITH_TRUTH);
  writePost(dir, 'notes.md', 'x');
  const names = todayPosts(dir, '2026-11-01').map((p) => path.basename(p));
  assert.deepEqual(names, ['2026-11-01-01.md', '2026-11-01-02.md']);
});

test('talkCount 数 L1 里的 talk 行', () => {
  const dir = tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '2026-11-01.mdl'),
    '00:10#1 act | 改了文件\n00:12#1 talk | 他说了一句\n00:20#2 talk | 又说一句\n',
    'utf8',
  );
  assert.equal(talkCount(dir, '2026-11-01'), 2);
  assert.equal(talkCount(dir, '2026-11-02'), 0);
});

test('checkWrapup：占位符 + 0 条 talk 都要报', () => {
  const dir = tmpdir();
  const sayDir = path.join(dir, '说');
  const l1Dir = path.join(dir, 'L1');
  writePost(sayDir, '2026-11-01-01.md', POST_WITH_PLACEHOLDER);
  fs.mkdirSync(l1Dir, { recursive: true });
  fs.writeFileSync(path.join(l1Dir, '2026-11-01.mdl'), '00:10#1 act | 改了文件\n', 'utf8');

  const r = checkWrapup({ sayDir, l1Dir, today: '2026-11-01' });
  assert.equal(r.ok, false);
  assert.equal(r.lines.length, 3);
  assert.match(r.lines[0], /三时刻：今天 1 篇里 1 篇/);
  assert.match(r.lines[1], /talk 行：今天 0 行/);
  assert.match(r.lines[2], /卡住/);
});

test('checkWrapup：真值写好、talk 有行，就干净', () => {
  const dir = tmpdir();
  const sayDir = path.join(dir, '说');
  const l1Dir = path.join(dir, 'L1');
  writePost(sayDir, '2026-11-01-01.md', POST_WITH_TRUTH);
  fs.mkdirSync(l1Dir, { recursive: true });
  fs.writeFileSync(path.join(l1Dir, '2026-11-01.mdl'), '00:12#1 talk | 他说了一句\n', 'utf8');

  const r = checkWrapup({ sayDir, l1Dir, today: '2026-11-01' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.lines, []);
});

test('checkWrapup：今天没发帖、也没有 L1，就不该报', () => {
  const dir = tmpdir();
  const r = checkWrapup({ sayDir: path.join(dir, '说'), l1Dir: path.join(dir, 'L1'), today: '2026-11-01' });
  assert.equal(r.ok, true);
});
