// skills.js —— 技能钩子的核心（从 `自我\tools\skills-hook.mjs` 搬进来）
//
// 为什么在插件里：技能不是「一份要读的文档」，是「挂在动作上的那一行」。
// 谁在动作发生的那一刻把它渲染出来，谁就拥有它——所以它属于插件，不属于裸脚本。

import fs from 'node:fs'

export const HOOKS = ['say', 'check', 'judge', 'edit', 'wrapup', 'release', 'media', 'research']
export const MAX_SHOWN = 3

export function loadSkills(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  return Array.isArray(raw) ? raw : raw.skills || []
}

/** 筛出该 hook 下活着的技能；when 命中 scene 的排前面。 */
export function pickSkills(skills, hook, scene = '', max = MAX_SHOWN) {
  const alive = (skills || []).filter((s) => s && s.state === 'alive' && s.hook === hook)
  const scored = alive.map((s, i) => ({
    s,
    i,
    score: scene && (s.when || '').includes(scene) ? 1 : 0,
  }))
  scored.sort((a, b) => (b.score - a.score) || (a.i - b.i))
  return { total: alive.length, shown: scored.slice(0, max).map((x) => x.s) }
}

/** 渲染成给人看的三行（或 JSON）。空的时候要说清「这是空的」，不能沉默。 */
export function renderSkills({ hook, scene = '', total = 0, shown = [] }, { json = false } = {}) {
  if (json) {
    return JSON.stringify({ hook, scene, total, shown: shown.map((s) => s.name) }, null, 2)
  }
  if (!shown.length) {
    return `（${hook} 下没有技能——这是空的，不是"没有需要提醒的"）`
  }
  const head = `【${hook}${scene ? ' · ' + scene : ''}】${total} 条命中，显示 ${shown.length} 条`
  const body = shown.map((s) => {
    const one = String(s.usage || '').split('\n')[0].trim()
    return `· ${s.name}：${one}`
  })
  const tail = total > shown.length
    ? `（另有 ${total - shown.length} 条没显示——超过 ${MAX_SHOWN} 条就只留 ${MAX_SHOWN} 条，别让钩子变噪音）`
    : ''
  return [head, ...body, tail].filter(Boolean).join('\n')
}

function dayKey(now) {
  const d = now instanceof Date ? now : new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 把命中写进计数（μ 的来源）。写失败不阻断动作。 */
export function bumpUsage(file, names, now = new Date()) {
  if (!names || !names.length) return false
  let usage = {}
  try {
    usage = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    usage = {}
  }
  const day = dayKey(now)
  usage[day] = usage[day] || {}
  for (const n of names) usage[day][n] = (usage[day][n] || 0) + 1
  usage.lastCall = (now instanceof Date ? now : new Date(now)).toISOString()
  try {
    fs.writeFileSync(file, JSON.stringify(usage, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 一次调用做完三件事：筛 → 渲染 → 计数。
 * 任何一步失败都不抛（动作优先于记账）。
 */
export function hookSkills({ hook, scene = '', skillsFile, usageFile, max = MAX_SHOWN, json = false, now = new Date() }) {
  if (!HOOKS.includes(hook)) {
    return { ok: false, error: `unknown hook: ${hook}（可用：${HOOKS.join('|')}）` }
  }
  let skills = []
  try {
    skills = loadSkills(skillsFile)
  } catch (e) {
    return { ok: false, error: `读不到技能池：${e.message}` }
  }
  const { total, shown } = pickSkills(skills, hook, scene, max)
  const text = renderSkills({ hook, scene, total, shown }, { json })
  let counted = 0
  if (shown.length && usageFile) {
    if (bumpUsage(usageFile, shown.map((s) => s.name), now)) counted = shown.length
  }
  return { ok: true, total, shown: shown.map((s) => s.name), counted, text }
}
