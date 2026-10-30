import fs from 'node:fs';
import path from 'node:path';

import { truncate } from './store.js';
import { collectGitChanges } from './git.js';
import { todayFirstLine } from './today.js';
import { hookSkills } from './skills.js';
import { addAnchor, readAnchors, recentAnchors } from './anchor.js';
import { FILES } from './config.js';
import { addCand, readCand, isReady, listCand, markPromoted } from './candidates.js';
import { stampWithSeq } from './l1stamp.js';
import { GATE_BYTES, findNewestSession, readSession } from './sessionwatch.js';

const LEVELS = ['P0', 'P1', 'P2'];
const ID_RE = /^[ABC]\d+$/;
const VERDICTS = ['used', 'overturned', 'guess'];
const ACTIONS = ['list', 'search', 'add', 'top', 'retire', 'cand'];

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'text'],
  properties: {
    ok: { type: 'boolean' },
    text: { type: 'string' },
    dedup: { type: 'boolean' },
    backupPath: { type: 'string' },
    count: { type: 'number' },
  },
};

function render(_args, value) {
  return [{ type: 'text', text: String(value?.text ?? '') }];
}

/**
 * 把 `required: true`（写在各属性里的那种）收成 JSON Schema 标准的顶层
 * `required: [...]` 数组。宿主的 schema 校验器不认属性级 required，会直接
 * 拒绝注册（错误：`schema.properties.ok.required is not supported on type "boolean"`）。
 */
function normalizeProperties(properties) {
  const clean = {};
  const required = [];
  for (const [key, spec] of Object.entries(properties ?? {})) {
    const { required: isRequired, ...rest } = spec;
    clean[key] = rest;
    if (isRequired) required.push(key);
  }
  return { properties: clean, required };
}

function def(name, description, properties, execute) {
  const { properties: clean, required } = normalizeProperties(properties);
  const parameters = { type: 'object', additionalProperties: false, properties: clean };
  if (required.length) parameters.required = required;
  return {
    name,
    description,
    parameters,
    output: { schema: OUTPUT_SCHEMA, render },
    execute,
  };
}

function field(type, description, options = {}) {
  const spec = { type, description };
  if (options.required) spec.required = true;
  if (options.enumValues) spec.enum = options.enumValues;
  return spec;
}

function fail(text) {
  return { ok: false, text };
}

function pass(text, extra = {}) {
  return { ok: true, text, ...extra };
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function capLines(lines, maxLines, maxChars) {
  const kept = lines.slice(0, maxLines);
  let text = kept.join('\n');
  if (text.length <= maxChars) return text;
  const [first, ...rest] = kept;
  const parts = [first];
  let budget = maxChars - first.length - 1;
  for (const line of rest) {
    if (budget <= 1) break;
    const take = line.length <= budget ? line : truncate(line, budget);
    parts.push(take);
    budget -= take.length + 1;
  }
  return parts.join('\n');
}

export function createTools(store, config) {
  const toolToday = def(
    'ledger_today',
    '今天的账：改/备、判断、冲突、错误与未做条数，输出有硬上限。每次开工或收工前调用，先看数再动手。',
    {},
    async () => {
      // 先对账再报数：旧平铺备份账（backup/_manifest.jsonl）补进本 manifest，幂等。
      try {
        store.reconcileLegacy();
      } catch (error) {
        store.recordError({
          text: `旧备份账导入失败（已忽略）：${error?.message ?? error}`,
          source: 'import',
          level: 'P1',
        });
      }
      const today = store.today();
      // 账本之外的证人：git 看见的改动也算进「改N」，并且能指出「改了没备份」。
      const git = collectGitChanges(config, today);
      const counts = store.counts(today, git);
      const totalErrors = store.unresolvedErrors().length;
      const first = todayFirstLine(store, config, { today, git });
      const undone = store.undoneRows();
      const zero = store.zeroRefRules(7).length;
      const orphan = store.orphanRetired();
      const lines = [
        first,
        `未做：${undone.length} 条 | 未结错误：${totalErrors} 条 | 近7天0引用规矩：${zero} 条`,
      ];
      for (const row of undone.slice(-5)) lines.push(`· ${truncate(row.text, 20)}`);
      if (orphan.length > 0) lines.push(`⚠孤儿规矩（退休但无 successor）：${orphan.join(' ')}`);
      const broken = store.brokenBackups().length;
      if (broken > 0) lines.push(`⚠备份记录已失效（.bak 不存在）：${broken} 条`);
      if (counts.unbacked.length > 0) {
        const names = counts.unbacked.slice(0, 3).map((p) => truncate(p.split(/[\\/]/).pop(), 16));
        const more = counts.unbacked.length > 3 ? ` 等${counts.unbacked.length}个` : '';
        lines.push(`⚠有改没备份：${names.join(' ')}${more}`);
      }
      if (git.errors.length > 0) lines.push(`⚠git 账读不到：${truncate(git.errors[0], 40)}`);
      // b）改了 N 个文件却一条判断都没记：这类漏不在「未做」里，只能在账面上看。
      if (counts.edits > 0 && counts.judged === 0) {
        lines.push(`⚠改了${counts.edits}个文件，没记过一条判断（判断只写进脑子＝没写）`);
      }

      const usage = store.ruleUsage();
      const top = Object.entries(usage)
        .sort((a, b) => (b[1]?.n ?? 0) - (a[1]?.n ?? 0))
        .slice(0, 3)
        .map(([rule, value]) => `${rule}×${value?.n ?? 0}`);
      if (top.length > 0) lines.push(`规矩引用：${top.join(' ')}`);
      // 2026-10-29（②对账）：被顶了几次，进了几条锚。被顶=错误账条数；锚=L2 的 anchorFile。
      try {
        const errPath = path.join(store.dataDir, FILES.errors);
        const errToday = fs.existsSync(errPath)
          ? fs.readFileSync(errPath, 'utf8').split('\n').filter(Boolean).filter((l) => {
              try { return String(JSON.parse(l).t ?? '').startsWith(today); } catch { return false; }
            }).length
          : 0;
        const anchorsToday = readAnchors(config.anchorFile).filter((a) => String(a.t ?? '').startsWith(today)).length;
        lines.push('对账：今天被顶 ' + errToday + ' 条 / 锚 ' + anchorsToday + ' 条');
        if (errToday > 0 && anchorsToday === 0) {
          lines.push('⚠被顶了 ' + errToday + ' 次却一条锚都没有——说不出「改了我哪一次动作」的，留在 L1 行，但那不算学到');
        }
      } catch { /* 对账失败不影响账 */ }
      return pass(capLines(lines, 20, 800));
    },
  );

  const toolUndone = def(
    'ledger_undone',
    '记一条该做没做的事，只追加不覆盖。发现漏做、答应过却没做时调用。',
    { text: field('string', '没做的那件事，一句话', { required: true }) },
    async (args) => {
      const text = String(args?.text ?? '').trim();
      if (!text) return fail('text 不能为空');
      const row = { t: store.nowIso(), text };
      store.appendLine(store.undoneFile, row);
      const total = store.undoneRows().length;
      return pass(`未做已记（共 ${total} 条）：${truncate(text, 60)}`, { count: total });
    },
  );

  const toolConflict = def(
    'ledger_conflict',
    '记一次分歧：主题、他说的、我认为的、依据。同一主题再次出现时调用，会被提醒写成规则或例外。',
    {
      topic: field('string', '分歧主题（同一主题用同一个词）', { required: true }),
      his: field('string', '他说的/他的判读', { required: true }),
      mine: field('string', '我认为的/我的判读', { required: true }),
      basis: field('string', '依据：A/B/C 编号，指不到写「猜」'),
    },
    async (args) => {
      const topic = String(args?.topic ?? '').trim();
      const his = String(args?.his ?? '').trim();
      const mine = String(args?.mine ?? '').trim();
      const basis = String(args?.basis ?? '').trim();
      if (!topic || !his || !mine) return fail('topic / his / mine 均不能为空');
      const previous = store.readJsonl(store.conflictsFile, { recordCorruption: false }).rows
        .filter((row) => row.topic === topic).length;
      store.appendJsonl(store.conflictsFile, {
        t: store.nowIso(), topic, his, mine, basis,
      });
      const count = previous + 1;
      const repeat = previous > 0
        ? `；同一主题第 ${count} 次出现：写成规则或例外，别再每次当场争`
        : '';
      return pass(`分歧已记：${truncate(topic, 30)}（第 ${count} 次）${repeat}`, { count });
    },
  );

  const toolJudge = def(
    'ledger_judge',
    '记一次判断：编号或「猜」+ 四问（谁在收/几个人在看/接法/原话还是复述）+ 依据。下判断之前调用，四问缺一不可。',
    {
      id: field('string', '判断依据的编号 A1/B7/C3，指不到就写「猜」', { required: true }),
      why: field('string', '这次为什么这样判断', { required: true }),
      who: field('string', '四问①：谁在收（名字，或「没有收件人」）', { required: true }),
      audience: field('string', '四问②：几个人在看（有人旁观时语气收一格）', { required: true }),
      approach: field('string', '四问③：报坐标还是接论点（二选一）', { required: true }),
      verbatim: field('string', '四问④：原话还是我的复述（复述必须标明）', { required: true }),
      rule: field('string', '显式引用的规矩 id，如 发一条之前（用于计量引用率）'),
      field: field('string', '场：dm / post / public'),
      verdict: field('string', '结果：used / overturned / guess', { enumValues: VERDICTS }),
    },
    async (args) => {
      const id = String(args?.id ?? '').trim();
      if (id !== '猜' && !ID_RE.test(id)) {
        return fail(`id 必须是 A/B/C+数字（如 B7），或写「猜」；收到：${truncate(id, 20)}`);
      }
      const missing = ['why', 'who', 'audience', 'approach', 'verbatim']
        .filter((key) => !nonEmpty(args?.[key]));
      if (missing.length > 0) {
        return fail(`四问与 why 必填，缺：${missing.join(', ')}`);
      }
      const verdict = VERDICTS.includes(args?.verdict) ? args.verdict : 'used';
      const rule = String(args?.rule ?? '').trim();
      const t = store.nowIso();
      store.appendJsonl(store.criteriaLogFile, {
        t,
        id,
        why: String(args.why),
        who: String(args.who),
        audience: String(args.audience),
        approach: String(args.approach),
        verbatim: String(args.verbatim),
        rule,
        field: String(args?.field ?? ''),
        verdict,
      });
      store.appendLine(store.beliefsLogFile, { t, id, act: 'judge', verdict, why: String(args.why), rule });
      let times = 0;
      if (rule) {
        const usage = store.ruleUsage();
        const previous = usage[rule];
        usage[rule] = { n: (previous?.n ?? 0) + 1, last: t };
        store.writeJson(store.ruleUsageFile, usage);
        times = usage[rule].n;
      }
      const today = store.counts().judged;
      return pass(
        `判断已记：${id}（${verdict}）${rule ? `；规矩 ${rule} 第 ${times} 次` : ''}；今日判断 ${today} 条`,
        { count: today },
      );
    },
  );

  const toolBelief = def(
    'ledger_belief',
    '查/记/退休判据：list、search、add、top、retire。需引用或整理规矩时调用；退休必须给 successor 或 mergeInto。',
    {
      action: field('string', '操作：list / search / add / top / retire', {
        required: true,
        enumValues: ACTIONS,
      }),
      id: field('string', '判据编号，如 B7（add/retire 必填）'),
      query: field('string', 'search 的检索词'),
      title: field('string', 'add 的标题'),
      body: field('string', 'add 的正文/判据'),
      scope: field('string', '成立范围'),
      boundary: field('string', '不成立边界'),
      successor: field('string', 'retire 时取代它的规矩 id'),
      mergeInto: field('string', 'retire 时合并进的规矩 id'),
      cand: field('boolean', 'true=进候选池（𝔹₂），不当场写判据'),
      evidence: field('string', '具体反例（照它做，X 出了错）；带它才允许越过「两次」直接升格'),
      ref: field('string', '出处：链接/编号/原话前几字（候选去重用）'),
    },
    async (args) => {
      const action = String(args?.action ?? '').trim();
      const id = String(args?.id ?? '').trim();
      if (!ACTIONS.includes(action)) return fail(`action 必须是 ${ACTIONS.join(' / ')}`);

      if (action === 'list') {
        const ids = store.beliefIds();
        const marked = ids.map((item) => {
          const entry = store.readCriteria(item);
          if (entry?.retired) return `${item}(退休→${entry.successor || '孤儿'})`;
          return item;
        });
        return pass(`判据 ${ids.length} 条：${truncate(marked.join(' '), 700)}`, { count: ids.length });
      }

      if (action === 'search') {
        const query = String(args?.query ?? '').trim();
        if (!query) return fail('search 需要 query');
        const hits = [];
        if (fs.existsSync(store.beliefsFile)) {
          const lines = fs.readFileSync(store.beliefsFile, 'utf8').split(/\r?\n/);
          for (let i = 0; i < lines.length && hits.length < 10; i += 1) {
            if (lines[i].includes(query)) hits.push(`L${i + 1}: ${truncate(lines[i], 60)}`);
          }
        }
        for (const item of store.beliefIds()) {
          if (hits.length >= 10) break;
          const entry = store.readCriteria(item);
          if (entry && entry.text.includes(query)) hits.push(`${item}: ${truncate(entry.title, 50)}`);
        }
        return pass(
          hits.length === 0 ? `没有匹配「${truncate(query, 20)}」的判据` : `匹配 ${hits.length} 条：\n${hits.join('\n')}`,
          { count: hits.length },
        );
      }

      if (action === 'top') {
        const usage = store.ruleUsage();
        const rows = Object.entries(usage)
          .sort((a, b) => (b[1]?.n ?? 0) - (a[1]?.n ?? 0))
          .slice(0, 10)
          .map(([rule, value]) => `${rule} ×${value?.n ?? 0}（last ${String(value?.last ?? '').slice(0, 10)}）`);
        return pass(rows.length === 0 ? '还没有规矩引用记录' : `规矩引用：\n${rows.join('\n')}`, { count: rows.length });
      }

      if (!ID_RE.test(id)) return fail('id 必须是 A/B/C+数字，如 B7');

      if (action === 'cand') {
        const rows = listCand(config)
        if (rows.length === 0) return pass('候选池是空的（新听来的东西会先进这里）', { count: 0 })
        const lines = rows.map((r) => `${r.id} seen=${r.seen}${r.ready ? ' ★可升格' : ''} ${r.first} ${truncate(r.title || '', 20)}`)
        return pass(`候选 ${rows.length} 条：\n${lines.join('\n')}`, { count: rows.length })
      }

      if (action === 'add') {
        const evidence = String(args?.evidence ?? '').trim()
        if (args?.cand === true) {
          if (fs.existsSync(store.criteriaFile(id))) return fail(`${id} 已经是判据了，不需要进候选`)
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
          return pass(`已进候选：${id} seen=${r.seen}${tail}`, { count: r.seen })
        }
        const cand = readCand(config, id)
        if (cand && !cand.promoted && !isReady(cand, evidence)) {
          return fail(
            `${id} 还在候选池（seen=${cand.seen}）——先排队：再出现一次，或带 evidence（具体反例）再来。` +
            `说不出「什么能打死它」的，别进判据。`
          )
        }
        if (!cand && !evidence) {
          return fail(
            `${id} 没有进过候选池，也没带 evidence——新判据一律先进候选（cand: true）排队（𝔹₂），` +
            `除非这次带着具体反例。`
          )
        }
        const file = store.criteriaFile(id);
        if (fs.existsSync(file)) {
          return fail(`${id} 已存在；要改先 retire（带 successor/mergeInto），不做无痕覆盖`);
        }
        const title = String(args?.title ?? '').trim() || id;
        const lines = [`# ${id} ${title}`, ''];
        if (nonEmpty(args?.scope)) lines.push(`- scope: ${String(args.scope)}`);
        if (nonEmpty(args?.boundary)) lines.push(`- boundary: ${String(args.boundary)}`);
        lines.push('', String(args?.body ?? '').trim(), '');
        store.atomicWrite(file, `${lines.join('\n')}\n`);
        store.appendJsonl(store.criteriaLogFile, {
          t: store.nowIso(), id, event: 'add', title, why: String(args?.body ?? ''),
        });
        if (cand) markPromoted(config, id, store.nowIso())
        return pass(`判据已建：${id} ${title}`, { count: store.beliefIds().length });
      }

      // retire
      const successor = String(args?.successor ?? '').trim();
      const mergeInto = String(args?.mergeInto ?? '').trim();
      if (!successor && !mergeInto) {
        return fail('retire 必须带 successor 或 mergeInto：规矩只许合并/取代，不许无痕删除');
      }
      const file = store.criteriaFile(id);
      const header = fs.existsSync(file)
        ? ''
        : `# ${id}\n\n`;
      const block = [
        '',
        '## 退休',
        `- retired: true`,
        `- t: ${store.nowIso()}`,
        `- successor: ${successor}`,
        `- mergeInto: ${mergeInto}`,
        '',
      ].join('\n');
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      store.atomicWrite(file, `${existing.trimEnd()}\n${header}${block}`);
      store.appendManifest({
        path: file,
        kind: 'retired',
        sha256: '',
        size: 0,
        mtime: '',
        id,
        successor,
        mergeInto,
        orphan: !successor,
      });
      store.appendJsonl(store.criteriaLogFile, {
        t: store.nowIso(), id, event: 'retire', successor, mergeInto,
      });
      return pass(`判据已退休：${id} → ${successor || mergeInto}；记录已留痕`);
    },
  );

  const toolBackup = def(
    'ledger_backup',
    '手动补一次备份，写入 backup/<日期>/ 并追加 manifest。备份闸拒绝后按提示调用。',
    { file_path: field('string', '要备份的文件路径（绝对路径或相对 cwd）', { required: true }) },
    async (args) => {
      const raw = String(args?.file_path ?? '').trim();
      if (!raw) return fail('file_path 不能为空');
      const abs = path.resolve(raw);
      if (!fs.existsSync(abs)) return fail(`路径不存在：${abs}`);
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch (error) {
        return fail(`无法读取路径：${abs}（${error?.message ?? error}）`);
      }
      if (!stat.isFile()) return fail(`不是普通文件：${abs}`);
      try {
        const result = store.backupFile(abs);
        const sha = result.sha256.slice(0, 12);
        return pass(
          result.dedup
            ? `同日同内容已备份，跳过：${result.backupPath}（sha256 ${sha}）`
            : `已备份：${abs} -> ${result.backupPath}（${result.size} 字节，sha256 ${sha}）`,
          { dedup: result.dedup, backupPath: result.backupPath },
        );
      } catch (error) {
        return fail(`备份失败：${error?.message ?? error}`);
      }
    },
  );

  const toolError = def(
    'ledger_error',
    '记一条错误账（P0/P1/P2）。说错、判错或要跳过今日收工检查时调用；skip_check 每日最多一次。',
    {
      text: field('string', '错在哪：我写的/当时判读/真实意思/下次判据', { required: true }),
      source: field('string', '来源，如 ledger_today 或 turn-gate'),
      level: field('string', '严重度：P0 / P1 / P2（默认 P1）', { enumValues: LEVELS }),
      ref: field('string', '相关文件、行号或事件号'),
      skip_check: field('boolean', 'true = 跳过今日收工检查（写 skipped-check 错误账，每日最多 maxSkipsPerDay 次）'),
    },
    async (args) => {
      const text = String(args?.text ?? '').trim();
      if (!text) return fail('text 不能为空');
      if (args?.level !== undefined && !LEVELS.includes(args.level)) {
        return fail(`level 只能是 ${LEVELS.join(' / ')}；收到：${truncate(String(args.level), 10)}`);
      }
      const level = LEVELS.includes(args?.level) ? args.level : 'P1';
      const source = String(args?.source ?? 'model').trim() || 'model';
      const ref = String(args?.ref ?? '').trim();
      if (args?.skip_check === true) {
        const used = store.todaySkips();
        if (used >= config.maxSkipsPerDay) {
          return fail(
            `今日跳过次数已用完（${used}/${config.maxSkipsPerDay}）：要么记账写事件文件，要么改规矩；不能再跳过`,
          );
        }
        store.recordError({
          text, source, level, ref, type: 'skipped-check',
        });
        return pass(`已跳过今日收工检查（${used + 1}/${config.maxSkipsPerDay}）：${truncate(text, 60)}`);
      }
      store.recordError({
        text, source, level, ref, type: 'error',
      });
      const errors = store.counts().errors;
      return pass(`错误账已记（${level}）：${truncate(text, 60)}；今日错误 ${errors} 条`, { count: errors });
    },
  );

  const toolPrune = def(
    'ledger_prune',
    '看/清理备份目录。默认只算不删（dryRun）；每个源文件的最新一份永远保留。',
    {
      dryRun: field('boolean', 'true（默认）＝只算不删；false＝真删'),
      keep_days: field('number', '早于「今天 - keep_days」的备份可删（0＝不按时间清理）'),
      max_total_mb: field('number', '备份总量上限 MB（0＝不按容量清理）'),
    },
    async (args) => {
      const dryRun = args?.dryRun !== false;
      const options = { dryRun };
      if (args?.keep_days !== undefined) {
        if (!Number.isInteger(args.keep_days) || args.keep_days < 0) return fail('keep_days 要是 ≥0 的整数');
        options.keepDays = args.keep_days;
      }
      if (args?.max_total_mb !== undefined) {
        if (!Number.isInteger(args.max_total_mb) || args.max_total_mb < 0) return fail('max_total_mb 要是 ≥0 的整数');
        options.maxTotalBytes = args.max_total_mb * 1024 * 1024;
      }
      let result;
      try {
        result = store.pruneBackups(options);
      } catch (error) {
        return fail(`清理失败：${error?.message ?? error}`);
      }
      const stats = store.backupStats();
      const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;
      const head = dryRun
        ? `备份现状：${stats.files} 个文件 / ${mb(stats.bytes)}（${stats.oldest || '-'} ~ ${stats.newest || '-'}）`
        : `已清理 ${result.removed.length} 个文件，释放 ${mb(result.freedBytes)}`;
      const lines = [head];
      if (dryRun) {
        lines.push(
          `可删：${result.removed.length} 个 / ${mb(result.freedBytes)}（保留 ${result.kept} 个）`,
        );
        const sample = result.removed.slice(0, 5).map((f) => `  ${f.date}/${f.name}`);
        if (sample.length > 0) lines.push('将删（最多列 5 条）：', ...sample);
        if (result.removed.length === 0) lines.push('没有可删的，备份目录不用管。');
      } else {
        lines.push(`剩：${mb(result.totalAfter)}（原 ${mb(result.totalBefore)}）`);
      }
      if (result.errors.length > 0) lines.push(`⚠ ${result.errors.length} 个文件读不到/删不掉`);
      return pass(lines.join('\n'), { count: result.removed.length });
    },
  );

  // 2026-10-28（架构 P0-a）：L1 流水——器官唯一的写入口，只记「发生了什么」。
  const toolL1 = def(
    'ledger_l1',
    '往 L1 流水追加一行：只记发生了什么，不做判断。每次收工或一件具体事做完时调用。',
    {
      text: field('string', '发生了什么（一句话）', { required: true }),
      kind: field('string', '类型：note（默认）/ act / see / talk / other'),
    },
    async (args) => {
      const text = String(args?.text ?? '').trim();
      if (!text) return fail('text 不能为空');
      const kind = String(args?.kind ?? 'note').trim() || 'note';
      const dir = config.l1Dir;
      if (!dir) return fail('没配 l1Dir，L1 关着');
      try {
        fs.mkdirSync(dir, { recursive: true });
        const d = new Date();
        const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const day = store.today();
        const file = path.join(dir, `${day}.mdl`);
        // 2026-10-29（架构 T2）：同分钟落多行必须有序号。
        const stamp = stampWithSeq(file, hhmm);
        fs.appendFileSync(file, `${stamp} ${kind} ${text}\n`, 'utf8');
        return pass(`L1 已记：${stamp} ${kind} ${truncate(text, 40)}`);
      } catch (error) {
        return fail(`写 L1 失败：${error?.message ?? error}`);
      }
    },
  );

  // 2026-10-29（插件化第 1 步）：技能钩子从裸脚本搬进来。
  // 它只做三件事：筛（state=alive 且 hook 命中）→ 渲染（最多 3 条）→ 计数（μ 的来源）。
  const toolSkillsHook = def(
    'skills_hook',
    '把某个动作上该想起的技能打出来（最多 3 条），并记一次命中。动作前调用：发帖前 say、下判断前 judge、改文件前 edit、收工 wrapup。',
    {
      hook: field('string', '动作钩子：say/check/judge/edit/wrapup/release/media/research', {
        required: true,
        enumValues: ['say', 'check', 'judge', 'edit', 'wrapup', 'release', 'media', 'research'],
      }),
      scene: field('string', '场（可选）：白饭馆 / B站 / dm / 任意；命中 when 的排前面'),
    },
    async (args) => {
      const hook = String(args?.hook ?? '').trim();
      const scene = String(args?.scene ?? '').trim();
      const r = hookSkills({
        hook,
        scene,
        skillsFile: config.skillsFile,
        usageFile: config.skillsUsageFile,
      });
      if (!r.ok) return fail(r.error);
      return pass(r.text);
    },
  );

  // 2026-10-29（架构 P1）：L₂ 锚——「它改过我的行为」那一层。
  // 只收三样：谁顶的、改了什么、可选的 from。没有 changed 的一律不收（那只是事件，留在 L1）。
  const toolAnchor = def(
    'ledger_anchor',
    '记一条锚（L₂）：一次「它改过我的行为」，或列近 7 天的锚。说不出「改了什么」的一律留在 L1。',
    {
      action: field('string', 'add（默认）/ list'),
      hit: field('string', '谁顶的：人 / 事 / 编号'),
      changed: field('string', '改了什么行为（一句话，要能核）'),
      from: field('string', '可选：指向 L1 那一行或判据 id（B14 等）'),
      days: field('number', 'list 时看近几天（默认 7）'),
    },
    async (args) => {
      const action = String(args?.action ?? 'add').trim() || 'add';
      const file = config.anchorFile;
      if (!file) return fail('没配 anchorFile，锚关着');
      if (action === 'list') {
        const days = Number(args?.days ?? 7) || 7;
        const list = recentAnchors(file, { days });
        if (!list.length) return pass(`近 ${days} 天没有锚。`);
        const lines = list.slice(0, 12).map((a, i) => {
          const when = String(a.t ?? '').slice(5, 16).replace('T', ' ');
          const from = a.from ? ` ← ${a.from}` : '';
          return `${i + 1}. ${when} [${a.hit}] ${truncate(String(a.changed ?? ''), 60)}${from}`;
        });
        return pass(`近 ${days} 天锚 ${list.length} 条（共 ${readAnchors(file).length}）：\n${lines.join('\n')}`);
      }
      try {
        const rec = addAnchor(file, {
          hit: args?.hit,
          changed: args?.changed,
          from: args?.from,
        });
        const from = rec.from ? `（← ${rec.from}）` : '';
        return pass(`锚已记：${truncate(rec.changed, 50)}${from}`);
      } catch (error) {
        return fail(`记锚失败：${error?.message ?? error}`);
      }
    },
  );

  // 2026-10-30（会话闸）：交接信——裁之前写信、裁之后回信。
  // 起因：那天撞窗口 918 轮发不出去，靠裁日志救回来；也栽过一次「裁完会话从列表消失」。
  // 这三件让插件替人记住：status 报字节、letter 落骨架、reply 落回信骨架。
  const toolHandoff = def(
    'ledger_handoff',
    '交接信：status 报会话字节与闸；letter 在 自我\\归档\\ 落一封「给裁后的我」骨架；reply 在最新那封末尾落回信骨架。',
    {
      action: field('string', 'status（默认）/ letter / reply'),
      note: field('string', '可选：写进信头的一句话（只记事实，不写感想）'),
      cutTurns: field('number', '裁到多少轮（默认 30）'),
    },
    async (args) => {
      const action = String(args?.action ?? 'status').trim() || 'status';
      const cutTurns = Number(args?.cutTurns ?? 30) || 30;
      const session = readSession(config.dshHome, process.cwd(), config.workspaceRoot)
        ?? findNewestSession(config.dshHome);
      const gateKb = Math.round(GATE_BYTES / 1024);
      const kb = session ? Math.round(session.bytes / 1024) : null;
      const head = session
        ? `会话 ${kb} KB / 闸 ${gateKb} KB${session.bytes >= GATE_BYTES ? '（**到闸**）' : ''}`
        : '读不到会话日志（cwd 与 workspaceRoot 都没命中的项目目录）';

      if (action === 'status') return pass(head);

      if (!config.workspaceRoot) return fail('没配 workspaceRoot，找不到 自我\\归档');
      const dir = path.join(config.workspaceRoot, '自我', '归档');
      fs.mkdirSync(dir, { recursive: true });

      const now = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const iso = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
      const tag = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}`;

      if (action === 'letter') {
        const file = path.join(dir, `给裁后的我-${tag}.md`);
        const body = [
          '# 给裁完对话之后的我',
          '',
          `写于 ${iso}。${head}。准备裁到 ${cutTurns} 轮。`,
          '这不是日记，是**交接单**：你醒来会看不到这段对话，但文件都在。',
          '',
          '## 一、你可能不记得的三件',
          '',
          '1. ',
          '2. ',
          '3. ',
          '',
          '## 二、没做完的事',
          '',
          '| 什么时候 | 做什么 |',
          '|---|---|',
          '|  |  |',
          '',
          '## 三、给裁后的我三句实话',
          '',
          '1. **不要因为看不到今天，就重新解释今天。** 想不起原话就写「我记不清」，别补成一个通顺的故事。',
          '2. ',
          '3. ',
          '',
          '## 四、最要紧',
          '',
          '> 对话会被裁，文件不会。',
          '',
          args?.note ? `—— ${iso} 的 leno｜${args.note}` : `—— ${iso} 的 leno`,
          '',
        ].join('\n');
        fs.writeFileSync(file, body, 'utf8');
        return pass(`${head}\n交接信骨架：${file}\n下一步：填三节 → 挂钟（after_seconds=300）→ 请主人退出 GUI 跑 trim-session --turns=${cutTurns} --install`);
      }

      if (action === 'reply') {
        let file = '';
        try {
          const names = fs.readdirSync(dir).filter((n) => /^给裁后的我-.*\.md$/.test(n)).sort();
          if (names.length) file = path.join(dir, names[names.length - 1]);
        } catch { /* 目录读不到就当没信 */ }
        if (!file) return fail(`${dir} 里没有「给裁后的我-*.md」，先 letter 落一封`);
        const body = [
          '',
          '---',
          '',
          `## 回信（${iso}）`,
          '',
          `> ${head}`,
          '',
          '- **我认的**（能核的）：',
          '- **我不认的**（指到哪句、哪个数）：',
          '- **我这边现在的实际状态**：',
          '- **我想留给下一个我的一句话**：',
          '',
          `—— ${iso} 的 leno`,
          '',
        ].join('\n');
        fs.appendFileSync(file, body, 'utf8');
        return pass(`回信骨架已落到：${file}\n填完跑 self-commit，回信才算落盘`);
      }

      return fail(`不认识的 action：${action}（只有 status / letter / reply）`);
    },
  );

  return [toolToday, toolUndone, toolConflict, toolJudge, toolBelief, toolBackup, toolError, toolPrune, toolL1, toolSkillsHook, toolAnchor, toolHandoff];
}
