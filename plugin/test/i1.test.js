import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { I1_HEADER, defaultI1File, loadI1 } from '../lib/i1.js'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'leno-i1-'))
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
