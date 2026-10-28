import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createTools } from '../lib/tools.js';
import { makeEnv, toolByName } from './helpers.js';

function build(env) {
  return new Map(createTools(env.store, env.config).map((tool) => [tool.name, tool]));
}

test('S5: 恰好注册 11 个工具，description ≤2 句且 output.render 是函数', () => {
  const env = makeEnv();
  try {
    const definitions = createTools(env.store, env.config);
    assert.deepEqual(definitions.map((d) => d.name), [
      'ledger_today', 'ledger_undone', 'ledger_conflict', 'ledger_judge',
      'ledger_belief', 'ledger_backup', 'ledger_error', 'ledger_prune', 'ledger_l1',
      'skills_hook', 'ledger_anchor',
    ]);
    for (const definition of definitions) {
      const sentences = (definition.description.match(/[。！？!?]/g) ?? []).length;
      assert.ok(sentences <= 2, `${definition.name} 描述超过 2 句`);
      assert.equal(typeof definition.output.render, 'function');
      assert.equal(definition.output.schema.type, 'object');
      assert.equal(definition.parameters.type, 'object');
    }
  } finally {
    env.cleanup();
  }
});

test('S5/S6: ledger_today 首行固定格式、行数 ≤20、字符 ≤800', async () => {
  const env = makeEnv();
  try {
    const tool = toolByName(build(env), 'ledger_today');
    const fresh = await tool.execute({});
    assert.equal(fresh.ok, true);
    assert.equal(fresh.text.split('\n')[0], '改0 备0 | 判断0 记0 | 冲突0 | 今日事件：无');

    for (let i = 0; i < 25; i += 1) {
      await toolByName(build(env), 'ledger_undone').execute({
        text: `第 ${i} 条很长很长很长很长很长很长很长很长的未做事项，需要被截断到二十字`,
      });
    }
    const text = (await tool.execute({})).text;
    const lines = text.split('\n');
    assert.ok(lines.length <= 20);
    assert.ok(text.length <= 800);
    assert.match(lines[0], /^改\d+ 备\d+ \| 判断\d+ 记\d+ \| 冲突\d+ \| 今日事件：[有无]/);
    for (const line of lines.slice(1)) {
      assert.ok(line.length <= 80, `line too long: ${line}`);
    }
  } finally {
    env.cleanup();
  }
});

test('S6 首行末尾：未结错误 ≥3 时显示 ⚠错误N', async () => {
  const env = makeEnv();
  try {
    const tools = build(env);
    for (let i = 0; i < 3; i += 1) {
      const result = await toolByName(tools, 'ledger_error').execute({
        text: `错误 ${i}`, level: 'P1',
      });
      assert.equal(result.ok, true);
    }
    const text = (await toolByName(tools, 'ledger_today').execute({})).text;
    assert.match(text.split('\n')[0], /⚠错误3$/);
  } finally {
    env.cleanup();
  }
});

test('S8: ledger_judge 校验编号与四问，合法时写 criteria-log 与规矩引用', async () => {
  const env = makeEnv();
  try {
    const tool = toolByName(build(env), 'ledger_judge');

    const badId = await tool.execute({
      id: 'D9', why: 'x', who: 'a', audience: 'b', approach: 'c', verbatim: 'd',
    });
    assert.equal(badId.ok, false);
    assert.match(badId.text, /A\/B\/C/);

    const missing = await tool.execute({ id: 'B1', why: 'x', who: 'a' });
    assert.equal(missing.ok, false);
    assert.match(missing.text, /四问与 why 必填/);

    const ok = await tool.execute({
      id: 'B1',
      why: '因为他先问了坐标',
      who: 'pianVei',
      audience: '公开，有围观',
      approach: '报坐标',
      verbatim: '我的复述',
      rule: '发一条之前',
      field: 'post',
      verdict: 'used',
    });
    assert.equal(ok.ok, true);
    assert.match(ok.text, /规矩/);

    const log = env.store.readJsonl(env.store.criteriaLogFile).rows;
    assert.equal(log.length, 1);
    assert.equal(log[0].who, 'pianVei');
    assert.equal(log[0].rule, '发一条之前');
    assert.equal(env.store.ruleUsage()['发一条之前'].n, 1);

    await tool.execute({
      id: '猜',
      why: '指不到依据',
      who: '没有收件人',
      audience: '只有我',
      approach: '接论点',
      verbatim: '原话',
      rule: '发一条之前',
    });
    assert.equal(env.store.ruleUsage()['发一条之前'].n, 2);
  } finally {
    env.cleanup();
  }
});

test('S8/六问6: ledger_error 校验 level，skip_check 每日只能用 maxSkipsPerDay 次', async () => {
  const env = makeEnv({ config: { maxSkipsPerDay: 1 } });
  try {
    const tool = toolByName(build(env), 'ledger_error');
    const badLevel = await tool.execute({ text: 'x', level: 'P9' });
    assert.equal(badLevel.ok, false);

    const first = await tool.execute({ text: '今天不写', skip_check: true });
    assert.equal(first.ok, true);
    assert.match(first.text, /1\/1/);
    assert.equal(env.store.todaySkips(), 1);

    const second = await tool.execute({ text: '再跳一次', skip_check: true });
    assert.equal(second.ok, false);
    assert.match(second.text, /跳过次数已用完/);
    assert.equal(env.store.todaySkips(), 1);
  } finally {
    env.cleanup();
  }
});

test('S8: ledger_error 普通模式写入 error 类型与今日计数', async () => {
  const env = makeEnv();
  try {
    const tool = toolByName(build(env), 'ledger_error');
    const result = await tool.execute({ text: '说错了一句', source: 'test', level: 'P0' });
    assert.equal(result.ok, true);
    assert.match(result.text, /今日错误 1 条/);
    const row = env.store.errorRows()[0];
    assert.equal(row.type, 'error');
    assert.equal(row.level, 'P0');
  } finally {
    env.cleanup();
  }
});

test('六问3: ledger_belief add/retire，退休必须带 successor 或 mergeInto', async () => {
  const env = makeEnv();
  try {
    const tool = toolByName(build(env), 'ledger_belief');

    const added = await tool.execute({
      action: 'add',
      id: 'B7',
      title: '问用途，不看句子像不像',
      body: '判断一桌是不是同类',
      scope: '判断别人',
      boundary: '一对一 + 对方认错时不成立',
    });
    assert.equal(added.ok, true);
    assert.ok(fs.existsSync(env.store.criteriaFile('B7')));

    const duplicate = await tool.execute({ action: 'add', id: 'B7' });
    assert.equal(duplicate.ok, false);

    const retireNoSuccessor = await tool.execute({ action: 'retire', id: 'B7' });
    assert.equal(retireNoSuccessor.ok, false);
    assert.match(retireNoSuccessor.text, /successor 或 mergeInto/);

    const retired = await tool.execute({ action: 'retire', id: 'B7', successor: 'A1' });
    assert.equal(retired.ok, true);
    const entry = env.store.readCriteria('B7');
    assert.equal(entry.retired, true);
    assert.equal(entry.successor, 'A1');
    assert.equal(env.store.orphanRetired().length, 0);
    assert.equal(env.store.manifestRows().filter((r) => r.kind === 'retired').length, 1);

    const listed = await tool.execute({ action: 'list' });
    assert.match(listed.text, /B7\(退休→A1\)/);
  } finally {
    env.cleanup();
  }
});

test('六问5: ledger_belief search 不返回全文，只回命中行', async () => {
  const env = makeEnv();
  try {
    fs.writeFileSync(env.store.beliefsFile, [
      '# 判断',
      '- **A1** 他一直爱着我',
      '- **B1** 有事实，而且它能让我失败',
      '',
    ].join('\n'), 'utf8');
    const tool = toolByName(build(env), 'ledger_belief');
    const result = await tool.execute({ action: 'search', query: '事实' });
    assert.equal(result.ok, true);
    assert.match(result.text, /B1/);
    assert.ok(result.text.length < 300);
  } finally {
    env.cleanup();
  }
});

test('S5/六问: ledger_conflict 同主题重复时提醒写规则或例外', async () => {
  const env = makeEnv();
  try {
    const tool = toolByName(build(env), 'ledger_conflict');
    const first = await tool.execute({ topic: '要不要回', his: '回', mine: '不回', basis: 'B3' });
    assert.equal(first.ok, true);
    const second = await tool.execute({ topic: '要不要回', his: '回', mine: '不回' });
    assert.match(second.text, /第 2 次/);
    assert.match(second.text, /规则或例外/);
    assert.equal(env.store.readJsonl(env.store.conflictsFile).rows.length, 2);
  } finally {
    env.cleanup();
  }
});

test('S5: ledger_undone 只追加并回总数', async () => {
  const env = makeEnv();
  try {
    const tool = toolByName(build(env), 'ledger_undone');
    const first = await tool.execute({ text: '没打开规矩' });
    const second = await tool.execute({ text: '没备份' });
    assert.equal(first.count, 1);
    assert.equal(second.count, 2);
    assert.equal(env.store.undoneRows().length, 2);
  } finally {
    env.cleanup();
  }
});

test('S9: 工具输出不回灌正文，只回摘要与计数', async () => {
  const env = makeEnv();
  try {
    const huge = '长'.repeat(5000);
    const result = await toolByName(build(env), 'ledger_undone').execute({ text: huge });
    assert.ok(result.text.length < 120);
  } finally {
    env.cleanup();
  }
});
