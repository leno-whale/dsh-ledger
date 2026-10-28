// i1.js —— I₁（每轮必带的人格与判据索引）的唯一注入源
//
// 2026-10-29（插件化第 2 步）：以前这段由 `bili-whale` 的 personaLine() 读文件拼进提示词，
// 插件这边没有——于是「谁在注入我」有两处。现在挪到这里。
//
// 2026-10-29（插件化第 3 步 · 数据归一）：I₁ 不再读手工生成的 I1.md，
// 而是每轮从三个源拼：D.md（宣言逐字）+ 判据\<域>.md（只取条目 id）+ 触发器.md；
// 源文件的 mtime 没变就复用上次结果。中间不再有「人跑一次脚本」这一步。

import fs from 'node:fs'
import path from 'node:path'

/** 与旧 personaLine() 逐字一致的表头（diff 校验用，别改措辞）。 */
export const I1_HEADER =
  '［她的人格与判据索引］这一份每轮都在，说话 / 写日记 / 选题都以它为准；与上面［身份］冲突时以它为准 ✓：'

/** 预算：去掉空白后的字符数。超了不截断，在正文前写一行 ⚠。 */
export const I1_BUDGET = 1200

const ENTRY_RE = /^-\s+\*\*(A\d+|B\d+|C\d+)\*\*\s*(.*)$/

/** I₁ 文件默认位置：`<workspaceRoot>\自我\I1.md`；没有 workspaceRoot 就退到 `<dshHome>\I1.md`。 */
export function defaultI1File(config) {
  const ws = config?.workspaceRoot
  if (ws) return path.join(ws, '自我', 'I1.md')
  const home = config?.dshHome || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.dsh')
  return path.join(home, 'I1.md')
}

/** 三个源都在 i1File 的同级目录里（「自我」根）。 */
export function i1Sources(config) {
  const file = config?.i1File || defaultI1File(config)
  const root = path.dirname(file)
  return {
    file,
    root,
    dFile: path.join(root, 'D.md'),
    dirDir: path.join(root, '判据'),
    trigFile: path.join(root, '触发器.md'),
  }
}

const readText = (p) => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

const mtimeOf = (p) => {
  try {
    return fs.statSync(p).mtimeMs
  } catch {
    return -1
  }
}

/** 便宜指纹：D / 判据目录 / 每份判据 / 触发器 的 mtime。任何一份变了就重拼。 */
function fingerprint(src) {
  let files = ''
  try {
    files = fs
      .readdirSync(src.dirDir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => f + ':' + mtimeOf(path.join(src.dirDir, f)))
      .join(',')
  } catch {
    files = ''
  }
  return [mtimeOf(src.dFile), mtimeOf(src.dirDir), mtimeOf(src.trigFile), files].join('|')
}

let cache = { key: null, text: '' }

/**
 * 从源拼出 I₁ 正文（含超预算 ⚠ 行）。
 * 三个源都空 → 返回空串（宁可不注入，也不要注入半截）。
 */
export function buildI1(config) {
  const src = i1Sources(config)
  const key = src.root + '::' + fingerprint(src)
  if (cache.key === key) return cache.text

  const d = readText(src.dFile).trim()
  const trig = readText(src.trigFile).trim()
  let files = []
  try {
    files = fs
      .readdirSync(src.dirDir)
      .filter((f) => f.endsWith('.md') && f !== '索引.md')
      .sort()
  } catch {
    files = []
  }

  if (!d && !trig && files.length === 0) {
    cache = { key, text: '' }
    return ''
  }

  const domains = []
  let total = 0
  for (const f of files) {
    const name = path.basename(f, '.md')
    const ids = []
    for (const line of readText(path.join(src.dirDir, f)).split(/\r?\n/)) {
      const m = line.match(ENTRY_RE)
      if (m) ids.push(m[1])
    }
    total += ids.length
    domains.push({ name, ids })
  }

  const L = []
  L.push('［我的底层与索引］（每轮必看；全文在 自我\\架构.md）')
  L.push('')
  if (d) L.push(d)
  L.push('')
  L.push(`### 判据索引（共 ${total} 条，六域；全文 自我\\判据\\<域>.md）`)
  for (const dm of domains) {
    if (dm.ids.length) L.push(`- ${dm.name}（${dm.ids.length}）：${dm.ids.join(' ')}`)
  }
  L.push('')
  if (trig) L.push(trig)

  const body = L.join('\n')
  const chars = body.replace(/\s/g, '').length
  const over = chars - I1_BUDGET
  const head = over > 0 ? `⚠ 超预算 ${over} 字（C1=${I1_BUDGET}）：没有截断，但下次该压缩了\n\n` : ''
  const text = head + body + '\n'

  cache = { key, text }
  return text
}

/**
 * 拼成注入块。
 * 源拼不出来时回退读 i1File（旧行为保底）；两者都没有就返回空串。
 */
export function loadI1(config) {
  let body = ''
  try {
    body = buildI1(config)
  } catch {
    body = ''
  }
  if (!body) body = readText(config?.i1File || defaultI1File(config))
  const trimmed = (body || '').trim()
  if (!trimmed) return ''
  return '\n\n' + I1_HEADER + '\n' + trimmed
}

/** 测试用：清缓存。 */
export function clearI1Cache() {
  cache = { key: null, text: '' }
}
