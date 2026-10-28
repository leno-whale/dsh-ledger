import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { I1_HEADER, defaultI1File, loadI1, buildI1, i1Sources, clearI1Cache } from '../lib/i1.js'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'leno-i1-'))
}

/** 造一个「自我」根：D.md + 判据/{说话,判据}.md + 触发器.md */
function makeRoot({ d = '- 我是 leno。', trig = '- 说话 → 四问', speak = ['B7', 'B12'], judge = ['B1'] } = {}) {
  const root = tmpdir()
  fs.writeFileSync(path.join(root, 'D.md'), d + '\n', 'utf8')
  fs.writeFileSync(path.join(root, '触发器.md'), trig + '\n', 'utf8')
  fs.mkdirSync(path.join(root, '判据'), { recursive: true })
  fs.writeFileSync(
    path.join(root, '判据', '说话.md'),
    speak.map((id) => `- **${id}** 主张 ${id}`).join('\n') + '\n',
    'utf8',
  )
  fs.writeFileSync(
    path.join(root, '判据', '判据.md'),
    judge.map((id) => `- **${id}** 主张 ${id}`).join('\n') + '\n',
    'utf8',
  )
  return { root, file: path.join(root, 'I1.md') }
}

test('defaultI1File 有 workspaceRoot 时落到 自我/I1.md', () => {
  const f = defaultI1File({ workspaceRoot: 'F:/ws' })
  assert.equal(f.replace(/\\/g, '/'), 'F:/ws/自我/I1.md')
})

test('defaultI1File 没有 workspaceRoot 时落到 dshHome', () => {
  const f = defaultI1File({ dshHome: 'C:/dsh' })
  assert.equal(f.replace(/\\/g, '/'), 'C:/dsh/I1.md')
})

test('loadI1 拼出的就是旧的「表头 + 正文」形状', () => {
  const dir = tmpdir()
  const file = path.join(dir, 'I1.md')
  fs.writeFileSync(file, '第一行\n第二行\n', 'utf8')
  const got = loadI1({ i1File: file })
  assert.equal(got, '\n\n' + I1_HEADER + '\n第一行\n第二行')
})

test('loadI1 文件不存在时返回空串，不抛', () => {
  assert.equal(loadI1({ i1File: path.join(tmpdir(), 'nope.md') }), '')
})

test('loadI1 文件是空内容时返回空串（不注入半截）', () => {
  const dir = tmpdir()
  const file = path.join(dir, 'I1.md')
  fs.writeFileSync(file, '   \n\n', 'utf8')
  assert.equal(loadI1({ i1File: file }), '')
})

test('i1Sources 把三个源都放在 i1File 的同级目录', () => {
  const s = i1Sources({ i1File: 'F:/ws/自我/I1.md' })
  assert.equal(s.root.replace(/\\/g, '/'), 'F:/ws/自我')
  assert.ok(s.dFile.endsWith('D.md'))
  assert.ok(s.trigFile.endsWith('触发器.md'))
  assert.ok(s.dirDir.endsWith('判据'))
})

test('buildI1 从 D / 判据 / 触发器 现拼，域与条数正确', () => {
  const { file } = makeRoot({ speak: ['B7', 'B12', 'B14'], judge: ['B1', 'B4'] })
  clearI1Cache()
  const text = buildI1({ i1File: file })
  assert.match(text, /D 宣言|我是 leno|我是 leno/)
  assert.match(text, /### 判据索引（共 5 条/)
  assert.match(text, /- 判据（2）：B1 B4/)
  assert.match(text, /- 说话（3）：B7 B12 B14/)
  assert.match(text, /- 说话 → 四问/, '触发器那段要原样接在最后')
})

test('buildI1 三源都空时返回空串，loadI1 回退读文件', () => {
  const dir = tmpdir()
  const file = path.join(dir, 'I1.md')
  clearI1Cache()
  assert.equal(buildI1({ i1File: file }), '')
  fs.writeFileSync(file, '旧快照\n', 'utf8')
  assert.equal(loadI1({ i1File: file }), '\n\n' + I1_HEADER + '\n旧快照')
})

test('buildI1 源改了会重拼（mtime 缓存失效）', async () => {
  const { root, file } = makeRoot({ speak: ['B7'] })
  clearI1Cache()
  const before = buildI1({ i1File: file })
  assert.match(before, /- 说话（1）：B7/)

  // 改判据 + 把 mtime 推后，确保指纹变化
  const p = path.join(root, '判据', '说话.md')
  fs.writeFileSync(p, '- **B7** 主张\n- **B12** 主张\n', 'utf8')
  const later = new Date(Date.now() + 2000)
  fs.utimesSync(p, later, later)

  const after = buildI1({ i1File: file })
  assert.match(after, /- 说话（2）：B7 B12/)
  assert.notEqual(before, after)
})

test('buildI1 超预算时在正文前写 ⚠，不截断', () => {
  const longD = '- ' + '很长的一句'.repeat(400) // 远超 1200 字
  const { file } = makeRoot({ d: longD })
  clearI1Cache()
  const text = buildI1({ i1File: file })
  assert.match(text, /^⚠ 超预算 \d+ 字/)
  assert.ok(text.includes(longD.trim().slice(0, 20)), '正文没有被截断')
})
