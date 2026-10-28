import fs from 'node:fs'
const f = 'plugin/lib/tools.js'
let t = fs.readFileSync(f, 'utf8')
const bad = "`${id} 没有进过候选池，也没带 evidence——新判据一律先 `cand: true` 排队（𝔹₂），` +"
const good = "`${id} 没有进过候选池，也没带 evidence——新判据一律先进候选（cand: true）排队（𝔹₂），` +"
if (!t.includes(bad)) throw new Error('没找到要修的那一行')
t = t.replace(bad, good)
fs.writeFileSync(f, t, 'utf8')
console.log('fixed')
