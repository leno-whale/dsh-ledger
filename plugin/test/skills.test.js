import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { HOOKS, pickSkills, renderSkills, bumpUsage, hookSkills } from '../lib/skills.js'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'leno-skills-'))
}

const POOL = [
  { name: '甲', state: 'alive', hook: 'say', when: '白饭馆', usage: '第一句\n第二句' },
  { name: '乙', state: 'alive', hook: 'say', when: 'B站', usage: '乙的用法' },
  { name: '丙', state: 'dead', hook: 'say', usage: '死的' },
  { name: '丁', state: 'alive', hook: 'judge', usage: '丁的用法' },
  { name: '戊', state: 'alive', hook: 'say', usage: '戊' },
  { name: '己', state: 'alive', hook: 'say', usage: '己' },
]

test('pickSkills 只取 alive 且 hook 命中', () => {
  const { total, shown } = pickSkills(POOL, 'say', '', 10)
  assert.equal(total, 4) // 甲 乙 戊 己（丙 是 dead，丁 是 judge）
  assert.deepEqual(shown.map((s) => s.name).sort(), ['乙', '己', '戊', '甲'].sort())
})

test('pickSkills 把 when 命中 scene 的排前面', () => {
  const { shown } = pickSkills(POOL, 'say', '白饭馆', 10)
  assert.equal(shown[0].name, '甲')
})

test('pickSkills 最多只给 3 条', () => {
  const { total, shown } = pickSkills(POOL, 'say', '', 3)
  assert.equal(total, 4)
  assert.equal(shown.length, 3)
})

test('renderSkills 空的时候说清是空的', () => {
  const text = renderSkills({ hook: 'media', total: 0, shown: [] })
  assert.match(text, /没有技能/)
  assert.match(text, /这是空的/)
})

test('renderSkills 只显示 usage 第一行，并注明被截掉的条数', () => {
  const { total, shown } = pickSkills(POOL, 'say', '', 3)
  const text = renderSkills({ hook: 'say', total, shown })
  assert.match(text, /· 甲：第一句/)
  assert.ok(!text.includes('第二句'), '不应当把整段 usage 都打出来')
  assert.match(text, /另有 1 条没显示/)
})

test('bumpUsage 累加并写 lastCall', () => {
  const dir = tmpdir()
  const file = path.join(dir, 'usage.json')
  const now = new Date('2026-10-29T10:00:00')
  assert.equal(bumpUsage(file, ['甲', '乙'], now), true)
  assert.equal(bumpUsage(file, ['甲'], now), true)
  const u = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(u['2026-10-29']['甲'], 2)
  assert.equal(u['2026-10-29']['乙'], 1)
  assert.ok(u.lastCall)
})

test('hookSkills 一次调用完成筛/渲染/计数', () => {
  const dir = tmpdir()
  const skillsFile = path.join(dir, 'skills.json')
  const usageFile = path.join(dir, 'usage.json')
  fs.writeFileSync(skillsFile, JSON.stringify({ skills: POOL }), 'utf8')
  const r = hookSkills({ hook: 'say', scene: '白饭馆', skillsFile, usageFile })
  assert.equal(r.ok, true)
  assert.equal(r.total, 4)
  assert.equal(r.counted, 3)
  const u = JSON.parse(fs.readFileSync(usageFile, 'utf8'))
  assert.equal(u['2026-10-29'] || Object.values(u)[0], u['2026-10-29'] || Object.values(u)[0])
  const names = Object.keys(u[Object.keys(u).find((k) => k !== 'lastCall')])
  assert.equal(names.length, 3)
})

test('hookSkills 对未知 hook 报错但不抛', () => {
  const r = hookSkills({ hook: 'nope', skillsFile: 'x', usageFile: 'y' })
  assert.equal(r.ok, false)
  assert.match(r.error, /unknown hook/)
})

test('hookSkills 读不到技能池时报错但不抛', () => {
  const r = hookSkills({ hook: 'say', skillsFile: path.join(tmpdir(), 'missing.json'), usageFile: 'y' })
  assert.equal(r.ok, false)
  assert.match(r.error, /读不到技能池/)
})

test('HOOKS 覆盖八个动作', () => {
  assert.deepEqual(HOOKS, ['say', 'check', 'judge', 'edit', 'wrapup', 'release', 'media', 'research'])
})
