import fs from 'node:fs'

// tools.test.js
{
  const f = 'plugin/test/tools.test.js'
  let t = fs.readFileSync(f, 'utf8')
  const a = `    const added = await tool.execute({
      action: 'add',
      id: 'B7',
      title: '问用途，不看句子像不像',
      body: '判断一桌是不是同类',
      scope: '判断别人',
      boundary: '一对一 + 对方认错时不成立',
    });`
  const b = `    // P5：新判据先排队两次（候选 seen=2）才允许升格
    for (let i = 0; i < 2; i += 1) {
      const queued = await tool.execute({
        action: 'add', id: 'B7', title: '问用途，不看句子像不像', body: '判断一桌是不是同类', cand: true,
      });
      assert.equal(queued.ok, true, '进候选应成功');
    }
    const added = await tool.execute({
      action: 'add',
      id: 'B7',
      title: '问用途，不看句子像不像',
      body: '判断一桌是不是同类',
      scope: '判断别人',
      boundary: '一对一 + 对方认错时不成立',
    });`
  if (t.split(a).length - 1 !== 1) throw new Error('tools.test 锚点没唯一命中')
  fs.writeFileSync(f, t.replace(a, b), 'utf8')
  console.log('tools.test ok')
}

// integration.test.js
{
  const f = 'plugin/test/integration.test.js'
  let t = fs.readFileSync(f, 'utf8')
  const a = `    await mock.tools.get('ledger_belief').execute({
      action: 'add', id: 'A9', title: '新规矩', body: '正文',
    });`
  const b = `    // P5：先排队两次（候选 seen=2），再升格
    for (let i = 0; i < 2; i += 1) {
      await mock.tools.get('ledger_belief').execute({
        action: 'add', id: 'A9', title: '新规矩', body: '正文', cand: true,
      });
    }
    await mock.tools.get('ledger_belief').execute({
      action: 'add', id: 'A9', title: '新规矩', body: '正文',
    });`
  if (t.split(a).length - 1 !== 1) throw new Error('integration 锚点没唯一命中')
  fs.writeFileSync(f, t.replace(a, b), 'utf8')
  console.log('integration ok')
}
