import fs from 'node:fs'
const f = 'plugin/lib/candidates.js'
let t = fs.readFileSync(f, 'utf8')
const a = "  const seen = Number.parseInt(pick('seen') || '1', 10)"
const b = `  // T4：连 seen/first 都没有的文件就是坏的——当 null，别编一条 seen=1 出来
  if (!/^-\\s*seen:\\s*\\d+/m.test(text) && !/^-\\s*first:/m.test(text)) return null
  const seen = Number.parseInt(pick('seen') || '1', 10)`
if (t.split(a).length - 1 !== 1) throw new Error('锚点没命中')
t = t.replace(a, b)
fs.writeFileSync(f, t, 'utf8')
console.log('ok')
