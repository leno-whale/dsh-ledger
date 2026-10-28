import fs from 'node:fs'
const f = 'docs/theory/README.md'
let t = fs.readFileSync(f, 'utf8')
const line = '| [一进一出-候选池与冷层.md](一进一出-候选池与冷层.md) | P5 候选池（𝔹₂ 三态）与 P6 冷层分册（按季切）的落地与测试标准；含「两条都还没实现」的现状 |'
if (!t.includes('一进一出')) {
  // 插在表格最后一行之后（表格以 | 开头）
  const lines = t.split(/\r?\n/)
  let last = -1
  lines.forEach((l, i) => { if (l.trim().startsWith('|')) last = i })
  lines.splice(last + 1, 0, line)
  fs.writeFileSync(f, lines.join('\n'), 'utf8')
  console.log('索引已加一行')
} else console.log('索引已有')
