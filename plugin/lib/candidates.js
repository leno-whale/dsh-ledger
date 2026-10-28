// 候选池（𝔹₂）：新听来的一句话先排队，出现两次、或带来具体反例，才升格成判据。
// 规则出自《架构》§7 与 docs/theory/一进一出-候选池与冷层.md 的 T1–T7。
// 设计要点：**只追加**（T2）——「第 N 次」一条一行，`seen` 由行数算，不回头改文件头。
import fs from 'node:fs'
import path from 'node:path'

const ID_RE = /^[ABC]\d+$/
const TIMES_RE = /^-\s*第\s*(\d+)\s*次/
const FIELD = (name) => new RegExp(`^-\\s*${name}:\\s*(.*)$`, 'm')

export function candidateDir(config) {
  if (config?.candidateDir) return config.candidateDir
  if (config?.workspaceRoot) return path.join(config.workspaceRoot, '自我', '候选')
  return path.join(config?.dshHome ?? '.', '候选')
}

export function candFile(config, id) {
  return path.join(candidateDir(config), `${id}.md`)
}

export function readCand(config, id) {
  const file = candFile(config, id)
  if (!fs.existsSync(file)) return null
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  if (!text.trim()) return null
  // T4：连 first / 「第 N 次」都没有的文件就是坏的——当 null，别编一条出来
  const times = text.split(/\r?\n/).filter((l) => TIMES_RE.test(l.trim()))
  if (times.length === 0 && !/^-\s*first:/m.test(text)) return null
  const pick = (name) => {
    const m = text.match(FIELD(name))
    return m ? m[1].trim() : ''
  }
  const declared = Number.parseInt(pick('seen') || '1', 10)
  const seen = Math.max(times.length, Number.isFinite(declared) ? declared : 1)
  return {
    id,
    file,
    seen,
    first: pick('first'),
    title: pick('title'),
    scope: pick('scope'),
    boundary: pick('boundary'),
    src: pick('src'),
    promoted: /^-\s*promoted:\s*true/m.test(text),
    times,
    text,
  }
}

export function listCand(config) {
  const dir = candidateDir(config)
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue
    const id = name.slice(0, -3)
    if (!ID_RE.test(id)) continue
    const c = readCand(config, id)
    if (c) out.push({ id, seen: c.seen, first: c.first, title: c.title, ready: isReady(c) })
  }
  return out.sort((a, b) => (a.first || '').localeCompare(b.first || ''))
}

export function isReady(cand, evidence) {
  if (!cand) return false
  if (cand.seen >= 2) return true
  return Boolean(String(evidence ?? '').trim())
}

/**
 * 记一次候选。已存在就追加一行「第 N 次」（seen 由行数算）。
 * 同一天、同一 tag 只 +1（T3 幂等）。
 */
export function addCand(config, { id, title, body, scope, boundary, src, evidence, today, ref }) {
  if (!ID_RE.test(id)) throw new Error(`id 必须是 A/B/C+数字，如 B7（收到 ${id}）`)
  const dir = candidateDir(config)
  fs.mkdirSync(dir, { recursive: true })
  const file = candFile(config, id)
  const now = today || new Date().toISOString().slice(0, 10)
  const tag = String(ref ?? src ?? body ?? '').slice(0, 24)
  const stamp = tag ? `〔${tag}〕` : ''

  if (!fs.existsSync(file)) {
    const lines = [
      `# ${id} ${title || id}`,
      '',
      '- seen: 1',
      `- first: ${now}`,
      `- title: ${title || id}`,
    ]
    if (scope) lines.push(`- scope: ${scope}`)
    if (boundary) lines.push(`- boundary: ${boundary}`)
    if (src) lines.push(`- src: ${src}`)
    if (evidence) lines.push(`- evidence: ${evidence}`)
    lines.push('', String(body ?? '').trim(), '', `- 第 1 次：${now}${stamp}`, '')
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
    return { created: true, seen: 1, ready: Boolean(evidence), file }
  }

  const cand = readCand(config, id)
  if (cand?.promoted) throw new Error(`${id} 已升格，不再进候选`)
  const text = fs.readFileSync(file, 'utf8')

  // T3：同一天同一 tag 已经记过一次 → 幂等
  const dup = text
    .split(/\r?\n/)
    .filter((l) => TIMES_RE.test(l.trim()))
    .some((l) => l.includes(now) && Boolean(stamp) && l.includes(stamp))
  if (dup) {
    return { created: false, seen: cand?.seen ?? 1, ready: isReady(cand, evidence), idempotent: true, file }
  }

  const next = (cand?.seen ?? 1) + 1
  let out = text
  if (evidence && !/^-\s*evidence:/m.test(out)) {
    out = out.replace(/^-\s*title:.*$/m, (m) => `${m}\n- evidence: ${evidence}`)
  }
  if (!out.endsWith('\n')) out += '\n'
  out += `- 第 ${next} 次：${now}${stamp}\n`
  fs.writeFileSync(file, out, 'utf8')
  return { created: false, seen: next, ready: next >= 2 || Boolean(evidence), file }
}

/** 升格：在候选里追加 promoted 标记（同样只追加，不改历史）。*/
export function markPromoted(config, id, now) {
  const file = candFile(config, id)
  if (!fs.existsSync(file)) return false
  const text = fs.readFileSync(file, 'utf8')
  if (/^-\s*promoted:\s*true/m.test(text)) return false
  const out = text.endsWith('\n') ? text : `${text}\n`
  fs.writeFileSync(file, `${out}- promoted: true\n- promotedAt: ${now}\n`, 'utf8')
  return true
}
