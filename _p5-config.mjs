import fs from 'node:fs'
const f = 'plugin/lib/config.js'
let t = fs.readFileSync(f, 'utf8')
const anchor = `    anchorFile: input.anchorFile
      ? path.resolve(String(input.anchorFile))
      : (workspaceRoot ? path.join(workspaceRoot, '自我', '锚.jsonl') : path.join(dshHome, '锚.jsonl')),
`
if (t.split(anchor).length - 1 !== 1) throw new Error('锚 anchorFile 段没唯一命中')
const add = anchor + `    // 2026-10-29（P5）：候选池（𝔹₂）目录——新听来的一句话先排队，不进判据。
    // 有 workspaceRoot 就落 \`<ws>\\自我\\候选\`，否则 \`<dshHome>\\候选\`。
    candidateDir: input.candidateDir
      ? path.resolve(String(input.candidateDir))
      : (workspaceRoot ? path.join(workspaceRoot, '自我', '候选') : path.join(dshHome, '候选')),
`
t = t.replace(anchor, add)
fs.writeFileSync(f, t, 'utf8')
console.log('config ok')
