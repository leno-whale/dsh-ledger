import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { FILES } from './config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 按 IANA 时区取 YYYY-MM-DD（跨时区不受进程 TZ 影响）。 */
export function dateInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const bag = {};
  for (const part of parts) {
    if (part.type !== 'literal') bag[part.type] = part.value;
  }
  return `${bag.year}-${bag.month}-${bag.day}`;
}

export function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export function truncate(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

function isObj(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 数据层：全部同步 API（guard 必须是同步函数）。
 * 每个文件写入都走 tmp -> fsync -> rename，读 JSONL 时跳过坏行。
 */
export class Store {
  constructor(config, options = {}) {
    this.config = config;
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    const home = config.dshHome;
    this.dshHome = home;
    // 数据文件都在 dataDir（默认：已有老账就留在 ~/.dsh 根上，新用户用 ~/.dsh/ledger）
    const data = config.dataDir || home;
    this.dataDir = data;
    this.conflictsFile = path.join(data, FILES.conflicts);
    this.manifestFile = path.join(data, FILES.manifest);
    this.errorFile = path.join(data, FILES.errors);
    this.criteriaDir = path.join(data, FILES.criteriaDir);
    this.ruleUsageFile = path.join(data, FILES.ruleUsage);
    this.criteriaLogFile = path.join(data, FILES.criteriaLog);
    this.beliefsFile = config.beliefsFile || path.join(data, FILES.beliefs);
    this.beliefsLogFile = path.join(data, FILES.beliefsLog);
    this.undoneFile = path.join(data, FILES.undone);
    this.backupRoot = config.backupRoot || path.join(home, 'backup');
    this.injectStateFile = path.join(data, FILES.injectState);
    // 空字符串＝该功能关着（默认），不再写死任何个人目录
    this.rulesDir = config.rulesDir || '';
    this.sayDir = config.sayDir || '';
  }

  /* ---------------------------------- 时间 ---------------------------------- */

  nowIso() {
    return this.now().toISOString();
  }

  today() {
    return dateInZone(this.now(), this.config.timeZone);
  }

  dateOf(iso) {
    const ms = Date.parse(String(iso ?? ''));
    if (Number.isNaN(ms)) return '';
    return dateInZone(new Date(ms), this.config.timeZone);
  }

  withinDays(iso, days) {
    const ms = Date.parse(String(iso ?? ''));
    if (Number.isNaN(ms)) return false;
    return this.now().getTime() - ms <= days * DAY_MS;
  }

  randomId() {
    return crypto.randomUUID();
  }

  /* ---------------------------------- 目录 ---------------------------------- */

  ensureDirs() {
    for (const dir of [this.dshHome, this.dataDir, this.criteriaDir, this.backupRoot]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // S2：六类数据文件在插件启用时就可发现；用追加模式打开，绝不截断已有内容。
    for (const file of [this.conflictsFile, this.manifestFile, this.errorFile, this.criteriaLogFile]) {
      try {
        fs.closeSync(fs.openSync(file, 'a'));
      } catch {
        /* 目录不可写时留给后续调用报错并走错误账 */
      }
    }
    try {
      fs.closeSync(fs.openSync(this.ruleUsageFile, 'a'));
      if (fs.statSync(this.ruleUsageFile).size === 0) this.writeJson(this.ruleUsageFile, {});
    } catch {
      /* 同上 */
    }
  }

  /* --------------------------------- 原子写 --------------------------------- */

  atomicWrite(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    let fd;
    try {
      fd = fs.openSync(tmp, 'w');
      fs.writeFileSync(fd, content, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmp, file);
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw error;
    }
  }

  atomicCopy(src, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.copyFileSync(src, tmp);
      const fd = fs.openSync(tmp, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, dest);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw error;
    }
  }

  /* --------------------------------- JSONL --------------------------------- */

  readJsonl(file, options = {}) {
    const record = options.recordCorruption !== false;
    if (!fs.existsSync(file)) return { rows: [], bad: 0 };
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      if (record) this.noteCorruption(file, 1);
      return { rows: [], bad: 1 };
    }
    const rows = [];
    let bad = 0;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '') continue;
      try {
        const value = JSON.parse(line);
        if (isObj(value)) rows.push(value);
        else bad += 1;
      } catch {
        bad += 1;
      }
    }
    if (bad > 0 && record) this.noteCorruption(file, bad);
    return { rows, bad };
  }

  appendJsonl(file, row, options = {}) {
    const record = options.recordCorruption !== false;
    const { rows, bad } = this.readJsonl(file, { recordCorruption: false });
    if (bad > 0 && record) this.noteCorruption(file, bad);
    const body = rows.map((r) => JSON.stringify(r));
    body.push(JSON.stringify(row));
    this.atomicWrite(file, `${body.join('\n')}\n`);
  }

  /**
   * 真追加：只往文件尾巴写一行，不重写既有内容。
   * 用于插件不拥有的文件（whale-undone.jsonl、whale-beliefs-log.jsonl），
   * 避免"读全量再重写"把既有坏行/并发写入的内容丢掉（S3）。
   */
  appendLine(file, row) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeFileSync(fd, `${JSON.stringify(row)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** 读损坏后写一条错误账；同一文件同一坏行数当日只记一次，避免刷屏。 */
  noteCorruption(file, badCount) {
    if (path.resolve(file) === path.resolve(this.errorFile)) return;
    const key = `${path.resolve(file)}#${badCount}`;
    try {
      const { rows } = this.readJsonl(this.errorFile, { recordCorruption: false });
      const today = this.today();
      const already = rows.some(
        (r) => r.type === 'corrupt' && r.ref === key && this.dateOf(r.t) === today,
      );
      if (already) return;
      this.appendJsonl(this.errorFile, {
        t: this.nowIso(),
        type: 'corrupt',
        text: `数据文件有 ${badCount} 行无法解析，已跳过并继续`,
        source: 'store',
        level: 'P2',
        ref: key,
      }, { recordCorruption: false });
    } catch {
      /* 错误账自身不可写时不再递归 */
    }
  }

  /* ---------------------------------- JSON --------------------------------- */

  readJson(file, fallback) {
    if (!fs.existsSync(file)) return fallback;
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return isObj(value) ? value : fallback;
    } catch {
      this.noteCorruption(file, 1);
      return fallback;
    }
  }

  writeJson(file, value) {
    this.atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
  }

  /* ---------------------------------- 指纹 --------------------------------- */

  sha256File(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }

  /* --------------------------------- 错误账 --------------------------------- */

  recordError({ text, source = 'plugin', level = 'P1', ref = '', type = 'error' }) {
    this.appendJsonl(this.errorFile, {
      t: this.nowIso(),
      type,
      text: String(text ?? ''),
      source: String(source ?? 'plugin'),
      level: ['P0', 'P1', 'P2'].includes(level) ? level : 'P1',
      ref: String(ref ?? ''),
    }, { recordCorruption: false });
  }

  errorRows() {
    return this.readJsonl(this.errorFile, { recordCorruption: false }).rows;
  }

  unresolvedErrors() {
    return this.errorRows().filter((r) => r.type === 'error');
  }

  todaySkips(today = this.today()) {
    return this.errorRows().filter(
      (r) => r.type === 'skipped-check' && this.dateOf(r.t) === today,
    ).length;
  }

  /* --------------------------------- manifest -------------------------------- */

  manifestRows() {
    return this.readJsonl(this.manifestFile, { recordCorruption: false }).rows;
  }

  appendManifest(row) {
    this.appendJsonl(this.manifestFile, { t: this.nowIso(), ...row });
  }

  /** 当日同路径、同 sha256 的备份记录。 */
  findTodayBackup(absPath, sha256, today = this.today()) {
    return this.manifestRows().find(
      (r) => r.kind === 'backup'
        && r.path === absPath
        && r.sha256 === sha256
        && this.dateOf(r.t) === today,
    );
  }

  /**
   * 把旧的平铺备份账（`~/.dsh/backup/_manifest.jsonl`，
   * 字段 {t, src, bak, bytes, sha16}）补进本插件的 manifest。
   *
   * 幂等：按 `路径|sha256|日期` 去重；`.bak` 的 sha 只有 16 位，不能直接用，
   * 一律对备份文件重算 sha256。返回 {imported, skipped, bad, dryRun}。
   */
  reconcileLegacy(options = {}) {
    const dryRun = options.dryRun === true;
    const result = { imported: 0, skipped: 0, bad: 0, dryRun };
    const legacyFile = path.join(this.backupRoot, '_manifest.jsonl');
    if (!fs.existsSync(legacyFile)) return result;

    const { rows, bad } = this.readJsonl(legacyFile, { recordCorruption: false });
    result.bad = bad;
    const existing = new Set(
      this.manifestRows()
        .filter((r) => r.kind === 'backup')
        .map((r) => `${path.resolve(String(r.path ?? ''))}|${r.sha256}|${this.dateOf(r.t)}`),
    );
    const shaCache = new Map();

    for (const row of rows) {
      const src = typeof row.src === 'string' ? row.src.trim() : '';
      const bak = typeof row.bak === 'string' ? row.bak.trim() : '';
      if (!src || !bak) { result.skipped += 1; continue; }

      let stat;
      try {
        stat = fs.statSync(bak);
      } catch {
        result.skipped += 1;
        continue;
      }
      if (!stat.isFile() || stat.size === 0) { result.skipped += 1; continue; }

      let sha256 = shaCache.get(bak);
      if (!sha256) {
        try {
          sha256 = this.sha256File(bak);
        } catch {
          result.skipped += 1;
          continue;
        }
        shaCache.set(bak, sha256);
      }

      const mtimeIso = new Date(stat.mtimeMs).toISOString();
      const day = this.dateOf(row.t) || this.dateOf(mtimeIso);
      const absSrc = path.resolve(src);
      const key = `${absSrc}|${sha256}|${day}`;
      if (existing.has(key)) { result.skipped += 1; continue; }

      if (!dryRun) {
        this.appendManifest({
          t: Number.isNaN(Date.parse(String(row.t ?? ''))) ? this.nowIso() : row.t,
          path: absSrc,
          sha256,
          size: Number(row.bytes) || stat.size,
          mtime: mtimeIso,
          kind: 'backup',
          backup: path.resolve(bak),
          imported: true,
        });
        existing.add(key);
      }
      result.imported += 1;
    }
    return result;
  }

  /** manifest 里指向的文件已不存在的备份记录（坏账，不静默算有效）。 */
  brokenBackups() {
    return this.manifestRows().filter(
      (r) => r.kind === 'backup' && (!r.backup || !fs.existsSync(String(r.backup))),
    );
  }

  /* ---------------------------------- 备份 ---------------------------------- */

  backupFile(absPath) {
    const st = fs.statSync(absPath);
    const sha256 = this.sha256File(absPath);
    const today = this.today();
    const existing = this.findTodayBackup(absPath, sha256, today);
    if (existing) {
      return { ok: true, dedup: true, backupPath: existing.backup, sha256, size: st.size };
    }
    const dir = path.join(this.backupRoot, today);
    fs.mkdirSync(dir, { recursive: true });
    const base = path.basename(absPath);
    let dest = path.join(dir, `${base}.bak`);
    let index = 2;
    while (fs.existsSync(dest)) {
      dest = path.join(dir, `${base}-${index}.bak`);
      index += 1;
    }
    this.atomicCopy(absPath, dest);
    this.appendManifest({
      path: absPath,
      sha256,
      size: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
      kind: 'backup',
      backup: dest,
    });
    return { ok: true, dedup: false, backupPath: dest, sha256, size: st.size };
  }

  /* ---------------------------------- 事件 ---------------------------------- */

  hasEventFile(today = this.today()) {
    try {
      if (!this.sayDir) return false; // 没配置＝该功能关着
      if (!fs.existsSync(this.sayDir)) return false;
      return fs.readdirSync(this.sayDir).some(
        (name) => name.startsWith(`${today}-`) && name.endsWith('.md'),
      );
    } catch {
      return false;
    }
  }

  /* ---------------------------------- 计数 ---------------------------------- */

  counts(today = this.today()) {
    const manifest = this.manifestRows().filter((r) => this.dateOf(r.t) === today);
    // 改 = 当日动过的去重路径数；导入的备份行也贡献一个路径，
    // 否则历史导入会显示成“改0 备9”这种更假的账。
    const edited = new Set(
      manifest
        .filter(
          (r) => r.kind === 'create' || r.kind === 'edit' || (r.kind === 'backup' && r.imported),
        )
        .map((r) => r.path),
    );
    const edits = edited.size;
    const backups = manifest.filter((r) => r.kind === 'backup').length;
    const imported = manifest.filter((r) => r.kind === 'backup' && r.imported).length;
    const judged = this.readJsonl(this.criteriaLogFile, { recordCorruption: false })
      .rows.filter(
        (r) => this.dateOf(r.t) === today && (r.event === undefined || r.event === 'judge'),
      ).length;
    const allErrors = this.unresolvedErrors();
    const errors = allErrors.filter((r) => this.dateOf(r.t) === today).length;
    const errorsTotal = allErrors.length;
    const conflicts = this.readJsonl(this.conflictsFile, { recordCorruption: false })
      .rows.filter((r) => this.dateOf(r.t) === today).length;
    return {
      edits, backups, imported, judged, errors, errorsTotal, conflicts,
    };
  }

  undoneRows() {
    return this.readJsonl(this.undoneFile).rows;
  }

  /* ---------------------------------- 规矩 ---------------------------------- */

  ruleUsage() {
    return this.readJson(this.ruleUsageFile, {});
  }

  /** 规矩全集：rulesDir/*.md 的文件名 + 用过的规矩 id。没配置 rulesDir 时只有用过的。 */
  ruleUniverse() {
    const ids = new Set(Object.keys(this.ruleUsage()));
    try {
      if (this.rulesDir && fs.existsSync(this.rulesDir)) {
        for (const name of fs.readdirSync(this.rulesDir)) {
          if (name.endsWith('.md')) ids.add(name.slice(0, -3));
        }
      }
    } catch {
      /* 目录不可读时退回已用规矩 */
    }
    return [...ids].filter(Boolean).sort();
  }

  zeroRefRules(days = 7) {
    const usage = this.ruleUsage();
    return this.ruleUniverse().filter((rule) => {
      const last = usage[rule]?.last;
      if (!last) return true;
      const ms = Date.parse(last);
      if (Number.isNaN(ms)) return true;
      return this.now().getTime() - ms > days * DAY_MS;
    });
  }

  /* --------------------------------- 判据仓 --------------------------------- */

  beliefIds() {
    const ids = new Set();
    try {
      if (fs.existsSync(this.beliefsFile)) {
        const text = fs.readFileSync(this.beliefsFile, 'utf8');
        for (const match of text.matchAll(/\*\*([ABC]\d+)\*\*/g)) ids.add(match[1]);
      }
    } catch {
      /* 读不到 beliefs 时只用 criteria 目录 */
    }
    try {
      if (fs.existsSync(this.criteriaDir)) {
        for (const name of fs.readdirSync(this.criteriaDir)) {
          const match = /^([ABC]\d+)\.md$/.exec(name);
          if (match) ids.add(match[1]);
        }
      }
    } catch {
      /* ignore */
    }
    return [...ids].sort((a, b) => {
      if (a[0] !== b[0]) return a[0].localeCompare(b[0]);
      return Number(a.slice(1)) - Number(b.slice(1));
    });
  }

  criteriaFile(id) {
    return path.join(this.criteriaDir, `${id}.md`);
  }

  readCriteria(id) {
    const file = this.criteriaFile(id);
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, 'utf8');
    return {
      id,
      text,
      title: (text.split(/\r?\n/).find((l) => l.startsWith('# ')) ?? '').replace(/^#\s*/, ''),
      retired: /^-\s*retired:\s*true/m.test(text),
      successor: (/- successor:\s*(.+)/.exec(text)?.[1] ?? '').trim(),
    };
  }

  /** 退休了但没有 successor 的“孤儿规矩”。 */
  orphanRetired() {
    if (!fs.existsSync(this.criteriaDir)) return [];
    const orphans = [];
    for (const name of fs.readdirSync(this.criteriaDir)) {
      const match = /^([ABC]\d+)\.md$/.exec(name);
      if (!match) continue;
      const entry = this.readCriteria(match[1]);
      if (entry?.retired && !entry.successor) orphans.push(entry.id);
    }
    return orphans;
  }

  /* --------------------------------- 注入状态 -------------------------------- */

  injectState() {
    return this.readJson(this.injectStateFile, {});
  }

  saveInjectState(state) {
    this.writeJson(this.injectStateFile, state);
  }
}

export { DAY_MS };
