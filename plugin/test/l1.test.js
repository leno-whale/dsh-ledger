import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-l1-'));
process.env.DSH_HOME = HOME;

const { default: plugin } = await import('../lib/index.js');

function fakeCtx(handlers, tools) {
  return {
    tools: {
      register: (definition) => { tools.push(definition); return () => {}; },
      guard: () => () => {},
    },
    on: (event, fn) => { handlers[event] = fn; return () => {}; },
    get: () => undefined,
    systemPrompt: { section: () => () => {} },
    effect: () => () => {},
  };
}

const LINE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2} 改\d+文 \/ 备\d+ \/ 判断\d+ \/ 事件[有无]$/;

test('收工闸往 L1 写一行，格式固定', () => {
  const l1Dir = path.join(HOME, 'L1-a');
  const handlers = {};
  plugin.apply(fakeCtx(handlers, []), { l1Dir });
  assert.equal(typeof handlers['agent/turn-stopping'], 'function');
  handlers['agent/turn-stopping']({});

  const files = fs.readdirSync(l1Dir).filter((f) => f.endsWith('.mdl'));
  assert.equal(files.length, 1);
  const lines = fs.readFileSync(path.join(l1Dir, files[0]), 'utf8').trim().split('\n');
  assert.ok(lines.length >= 1);
  assert.match(lines[0], LINE_RE);
});

test('ledger_l1 追加一行（默认 kind=note）', async () => {
  const l1Dir = path.join(HOME, 'L1-b');
  const handlers = {};
  const tools = [];
  plugin.apply(fakeCtx(handlers, tools), { l1Dir });

  const tool = tools.find((t) => t.name === 'ledger_l1');
  assert.ok(tool, 'ledger_l1 没注册上');

  const result = await tool.execute({ text: '测试一行' });
  assert.equal(result.ok, true);

  const files = fs.readdirSync(l1Dir).filter((f) => f.endsWith('.mdl'));
  const body = fs.readFileSync(path.join(l1Dir, files[0]), 'utf8');
  assert.match(body, /^\d{2}:\d{2} note 测试一行$/m);
});

test('目录不存在时自动建', async () => {
  const l1Dir = path.join(HOME, 'deep', 'nested', 'L1-c');
  const handlers = {};
  const tools = [];
  plugin.apply(fakeCtx(handlers, tools), { l1Dir });
  const tool = tools.find((t) => t.name === 'ledger_l1');
  const result = await tool.execute({ text: '自动建目录' });
  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(l1Dir));
});

test('L1 写失败不抛（路径被文件占住）', () => {
  const blocked = path.join(HOME, 'blocked-file');
  fs.writeFileSync(blocked, 'x', 'utf8');
  const handlers = {};
  plugin.apply(fakeCtx(handlers, []), { l1Dir: blocked });
  assert.doesNotThrow(() => handlers['agent/turn-stopping']({}));
});

test('数值没变就不写（去噪）', () => {
  const l1Dir = path.join(HOME, 'L1-d');
  const handlers = {};
  plugin.apply(fakeCtx(handlers, []), { l1Dir });
  handlers['agent/turn-stopping']({});
  handlers['agent/turn-stopping']({});
  handlers['agent/turn-stopping']({});
  const files = fs.readdirSync(l1Dir).filter((f) => f.endsWith('.mdl'));
  const lines = fs.readFileSync(path.join(l1Dir, files[0]), 'utf8').trim().split('\n')
    .filter((l) => LINE_RE.test(l));
  assert.equal(lines.length, 1, '同样的计数连着写三次，计数行应该只剩一行');
});

test('被顶了却没写锚，L1 里喊一句（对账）', () => {
  const l1Dir = path.join(HOME, 'L1-e');
  const data = path.join(HOME, 'ledger-e');
  fs.mkdirSync(data, { recursive: true });
  const today = new Date();
  const p2 = (x) => String(x).padStart(2, '0');
  const iso = `${today.getFullYear()}-${p2(today.getMonth() + 1)}-${p2(today.getDate())}T${p2(today.getHours())}:${p2(today.getMinutes())}:00.000Z`;
  fs.writeFileSync(path.join(data, 'ledger-errors.jsonl'),
    JSON.stringify({ t: iso, text: '被顶了一次', level: 'P1' }) + '\n', 'utf8');
  const handlers = {};
  plugin.apply(fakeCtx(handlers, []), { l1Dir, dataDir: data, anchorFile: path.join(HOME, 'anchors-e.jsonl') });
  handlers['agent/turn-stopping']({});
  const files = fs.readdirSync(l1Dir).filter((f) => f.endsWith('.mdl'));
  const body = fs.readFileSync(path.join(l1Dir, files[0]), 'utf8');
  assert.match(body, /⚠ 对账：今天被顶 1 次，锚 0 条/);
});
