import fs from 'node:fs'
import path from 'node:path'

const P = 'plugin'
const repoRoot = process.cwd()
const prof = 'C:\\Users\\HUAWEI\\.dsh\\profiles\\desktop\\node_modules\\dsh-ledger'

// 1) 版本
const pkgFile = path.join(P, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
const oldV = pkg.version
pkg.version = '0.6.7'
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

const idxFile = path.join(P, 'lib', 'index.js')
let idx = fs.readFileSync(idxFile, 'utf8')
idx = idx.replace(/export const VERSION = '[^']*'/, "export const VERSION = '0.6.7'")
fs.writeFileSync(idxFile, idx, 'utf8')

// 2) CHANGELOG
const chFile = path.join(P, 'CHANGELOG.md')
let ch = fs.readFileSync(chFile, 'utf8')
const entry = `## 0.6.7 — 2026-10-29（P5：候选池）

新判据不再「想到就写」。\`ledger_belief add\` 现在先查候选池（𝔹₂）：

- \`cand: true\` → 写进 \`自我\\候选\\<id>.md\`（\`seen\` / \`first\` / 「第 N 次」一行一条，**只追加**）
- 不带 \`cand\` 且候选里没有、也没带 \`evidence\`（具体反例）→ **拒绝写入判据**，提示先排队
- \`seen ≥ 2\` 或带了 \`evidence\` → 允许升格，并在候选里追加 \`promoted: true\`
- 新增 \`action: 'cand'\` 列候选池（★ 标可升格）
- 新文件 \`lib/candidates.js\`、新配置 \`candidateDir\`（默认 \`<ws>\\自我\\候选\`）、新增 \`test/candidate.test.js\` 7 项

来历：2026-10-28 一天里中层判据从 21 涨到 26，B22–B26 全是听完就写进去的——收集被当成了长进。

`
ch = entry + ch
fs.writeFileSync(chFile, ch, 'utf8')

// 3) 同步 profile（复制文件 + 核 sha）
const files = ['lib/candidates.js', 'lib/tools.js', 'lib/config.js', 'lib/index.js', 'package.json', 'CHANGELOG.md']
const crypto = await import('node:crypto')
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 12)
for (const rel of files) {
  const src = path.join(P, rel)
  const dst = path.join(prof, rel)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
  const a = sha(src), b = sha(dst)
  console.log(`${rel}  ${a} ${a === b ? '一致 ✓' : '不一致 ✗'}`)
}
const pv = JSON.parse(fs.readFileSync(path.join(prof, 'package.json'), 'utf8')).version
console.log('版本', oldV, '→', pv)
fs.writeFileSync(path.join(repoRoot, '_p5-done.txt'), `version ${pv}\n`, 'utf8')
