import fs from 'node:fs'
const f = 'plugin/lib/tools.js'
let t = fs.readFileSync(f, 'utf8')
const rep = (a, b, tag) => {
  const n = t.split(a).length - 1
  if (n !== 1) throw new Error(`[${tag}] 期望 1 处，实际 ${n} 处`)
  t = t.replace(a, b)
}

rep(
  "import { FILES } from './config.js';",
  "import { FILES } from './config.js';\nimport { addCand, readCand, isReady, listCand, markPromoted } from './candidates.js';",
  'import'
)
rep(
  "const ACTIONS = ['list', 'search', 'add', 'top', 'retire'];",
  "const ACTIONS = ['list', 'search', 'add', 'top', 'retire', 'cand'];",
  'actions'
)
rep(
  "      mergeInto: field('string', 'retire 时合并进的规矩 id'),",
  "      mergeInto: field('string', 'retire 时合并进的规矩 id'),\n      cand: field('boolean', 'true=进候选池（𝔹₂），不当场写判据'),\n      evidence: field('string', '具体反例（照它做，X 出了错）；带它才允许越过「两次」直接升格'),\n      ref: field('string', '出处：链接/编号/原话前几字（候选去重用）'),",
  'params'
)
rep(
  "      if (action === 'add') {\n        const file = store.criteriaFile(id);",
  `      if (action === 'cand') {
        const rows = listCand(config)
        if (rows.length === 0) return pass('候选池是空的（新听来的东西会先进这里）', { count: 0 })
        const lines = rows.map((r) => \`\${r.id} seen=\${r.seen}\${r.ready ? ' ★可升格' : ''} \${r.first} \${truncate(r.title || '', 20)}\`)
        return pass(\`候选 \${rows.length} 条：\\n\${lines.join('\\n')}\`, { count: rows.length })
      }

      if (action === 'add') {
        const evidence = String(args?.evidence ?? '').trim()
        if (args?.cand === true) {
          if (fs.existsSync(store.criteriaFile(id))) return fail(\`\${id} 已经是判据了，不需要进候选\`)
          const r = addCand(config, {
            id,
            title: String(args?.title ?? '').trim() || id,
            body: String(args?.body ?? ''),
            scope: args?.scope,
            boundary: args?.boundary,
            src: String(args?.ref ?? '').trim(),
            evidence,
            ref: String(args?.ref ?? '').trim(),
          })
          const tail = r.ready ? '（已够升格条件，可以 add 了）' : '（再出现一次、或带来具体反例，才升格）'
          return pass(\`已进候选：\${id} seen=\${r.seen}\${tail}\`, { count: r.seen })
        }
        const cand = readCand(config, id)
        if (cand && !cand.promoted && !isReady(cand, evidence)) {
          return fail(
            \`\${id} 还在候选池（seen=\${cand.seen}）——先排队：再出现一次，或带 evidence（具体反例）再来。\` +
            \`说不出「什么能打死它」的，别进判据。\`
          )
        }
        if (!cand && !evidence) {
          return fail(
            \`\${id} 没有进过候选池，也没带 evidence——新判据一律先 \`cand: true\` 排队（𝔹₂），\` +
            \`除非这次带着具体反例。\`
          )
        }
        const file = store.criteriaFile(id);`,
  'gate'
)
rep(
  "        return pass(\`判据已建：\${id} \${title}\`, { count: store.beliefIds().length });",
  "        if (cand) markPromoted(config, id, store.nowIso())\n        return pass(\`判据已建：\${id} \${title}\`, { count: store.beliefIds().length });",
  'promote-mark'
)
fs.writeFileSync(f, t, 'utf8')
console.log('patch ok')
