// i1.js —— I₁（每轮必带的人格与判据索引）的唯一注入源
//
// 2026-10-29（插件化第 2 步）：以前这段由 `bili-whale` 的 personaLine() 读文件拼进提示词，
// 插件这边没有——于是「谁在注入我」有两处。现在挪到这里：
//   · 生成：`自我\tools\build-i1.mjs`（预算 C1=1200 字，超了写 ⚠ 不静默截断）
//   · 注入：本文件 → index.js 的 systemPrompt.section（order 10250）
//   · `bili-whale` 只保留［身份］那一行（名字/称呼来自它的配置），不再读 I1.md。

import fs from 'node:fs'
import path from 'node:path'

/** 与旧 personaLine() 逐字一致的表头（diff 校验用，别改措辞）。 */
export const I1_HEADER =
  '［她的人格与判据索引］这一份每轮都在，说话 / 写日记 / 选题都以它为准；与上面［身份］冲突时以它为准 ✓：'

/** I₁ 文件默认位置：`<workspaceRoot>\自我\I1.md`；没有 workspaceRoot 就退到 `<dshHome>\I1.md`。 */
export function defaultI1File(config) {
  const ws = config?.workspaceRoot
  if (ws) return path.join(ws, '自我', 'I1.md')
  const home = config?.dshHome || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.dsh')
  return path.join(home, 'I1.md')
}

/**
 * 读出 I₁ 并拼成注入块。
 * 读不到就返回空串（不抛）——没有 I₁ 时宁可不注入，也不要注入半截。
 */
export function loadI1(config) {
  const file = config?.i1File || defaultI1File(config)
  try {
    const text = fs.readFileSync(file, 'utf8').trim()
    if (!text) return ''
    return '\n\n' + I1_HEADER + '\n' + text
  } catch {
    return ''
  }
}
