import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { FILES, LEGACY_NAMES } from './config.js';

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

const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES', 'EXDEV']);

/** 同步小睡（不引入依赖，也不用 async）。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Windows 上 rename 会被杀软/索引器临时占住，报 EPERM/EBUSY。
 * 这不是逻辑错，是「文件正被别的手拿着」，退一步重试就好；
 * 重试几次还不行才抛——抛出去就是真的写失败了。
 */
export function renameWithRetry(from, to, attempts = 6) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      last = error;
      if (!error || !RETRYABLE_RENAME.has(error.code)) throw error;
      sleepSync(10 * (i + 1));
    }
  }
  throw last;
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
    this.pruneLogFile = path.join(data, FILES.pruneLog);
    // 跨进程锁：放在 dataDir 下，同一本账只有一个锁
    this.lockPath = path.join(data, '.lock');
    this.lockDepth = 0;
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
    this.migrateLegacyNames();
    // S2：六类数据文件在插件启用时就可发现；用追加模式打开，绝不截断已有内容。
    for (const file of [this.conflictsFile, this.manifestFile, this.errorFile, this.criteriaLogFile, this.pruneLogFile]) {
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

  /* ------------------------------ 老文件名迁移 ------------------------------ */

  /**
   * v0.4③：把 v0.3 及以前的 `whale-*` 文件搬到现在的名字。
   * 只搬插件自己拥有的账；使用者自己的本子（beliefs / beliefs-log / undone）不动。
   * 两边都存在时不合并、不删——记一条错误账，等人来看（合并错一次就丢历史）。
   */
  migrateLegacyNames() {
    const actions = [];
    for (const [oldName, newName] of Object.entries(LEGACY_NAMES)) {
      if (oldName === newName) continue;
      const from = path.join(this.dataDir, oldName);
      const to = path.join(this.dataDir, newName);
      if (!fs.existsSync(from)) continue;
      if (!fs.existsSync(to)) {
        try {
          fs.renameSync(from, to);
          actions.push({ from: oldName, to: newName, action: 'renamed' });
        } catch (error) {
          actions.push({ from: oldName, to: newName, action: 'failed', error: String(error?.message ?? error) });
        }
        continue;
      }
      actions.push({ from: oldName, to: newName, action: 'kept-both' });
    }
    const needsHuman = actions.filter((a) => a.action !== 'renamed');
    if (needsHuman.length > 0) {
      const summary = needsHuman
        .map((a) => `${a.from}${a.action === 'kept-both' ? '（新旧都在，未合并）' : `（搬不动：${a.error}）`}`)
        .join('；');
      try {
        this.recordError({
          text: `文件名迁移没做完：${summary}`,
          source: 'migrate',
          level: 'P1',
          ref: this.dataDir,
          type: 'migration',
        });
      } catch {
        /* 记不上也不能挡住启动 */
      }
    }
    return actions;
  }

  /* -------------------------------- 备份清理 -------------------------------- */

  /** 备份目录的规模：按日期目录统计，顺带给出最老/最新。 */
  backupStats() {
    const root = this.backupRoot;
    const result = { dirs: [], files: 0, bytes: 0, oldest: '', newest: '', errors: [] };
    let dirs = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
        .map((d) => d.name)
        .sort();
    } catch (error) {
      if (error && error.code !== 'ENOENT') result.errors.push(String(error.message ?? error));
      return result;
    }
    for (const date of dirs) {
      let count = 0;
      let bytes = 0;
      let entries = [];
      try {
        entries = fs.readdirSync(path.join(root, date));
      } catch (error) {
        result.errors.push(`${date}: ${String(error?.message ?? error)}`);
        continue;
      }
      for (const name of entries) {
        try {
          const st = fs.statSync(path.join(root, date, name));
          if (!st.isFile()) continue;
          count += 1;
          bytes += st.size;
        } catch {
          /* 读不到就不算 */
        }
      }
      result.dirs.push({ date, files: count, bytes });
      result.files += count;
      result.bytes += bytes;
    }
    if (result.dirs.length > 0) {
      result.oldest = result.dirs[0].date;
      result.newest = result.dirs[result.dirs.length - 1].date;
    }
    return result;
  }

  /**
   * 清理旧备份。默认 **dryRun**：只算不删。
   * 两条政策，都不许「一个源文件一份不留」：
   *   - keepDays：早于「今天 - keepDays」的日期目录里的文件可以删；
   *   - maxTotalBytes：总量超限时从最老的日期开始删，直到达标。
   * 每个源文件（去掉 `-2`/`-3` 后缀）的最新一份**永远保留**。
   */
  pruneBackups(options = {}) {
    const dryRun = options.dryRun !== false;
    const keepDays = Number.isInteger(options.keepDays)
      ? options.keepDays
      : (this.config.backupKeepDays ?? 0);
    const maxTotalBytes = Number.isInteger(options.maxTotalBytes)
      ? options.maxTotalBytes
      : (this.config.backupMaxTotalMb ?? 0) * 1024 * 1024;
    const root = this.backupRoot;
    const today = this.today();
    const cutoff = keepDays > 0
      ? dateInZone(new Date(this.now().getTime() - keepDays * DAY_MS), this.config.timeZone)
      : '';

    const files = [];
    let dirs = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
        .map((d) => d.name)
        .sort();
    } catch {
      return { dryRun, removed: [], kept: 0, freedBytes: 0, totalBefore: 0, totalAfter: 0, errors: [] };
    }
    const errors = [];
    for (const date of dirs) {
      let names = [];
      try {
        names = fs.readdirSync(path.join(root, date));
      } catch (error) {
        errors.push(`${date}: ${String(error?.message ?? error)}`);
        continue;
      }
      for (const name of names) {
        const abs = path.join(root, date, name);
        try {
          const st = fs.statSync(abs);
          if (!st.isFile()) continue;
          files.push({ date, name, abs, bytes: st.size, mtimeMs: st.mtimeMs });
        } catch {
          /* 读不到就不算 */
        }
      }
    }

    // 每个源文件的最新一份：先比 mtime；同一毫秒再按日期/文件名定序（CI 上两次写会同毫秒）
    const newestBySource = new Map();
    for (const f of files) {
      const source = path.basename(f.name).replace(/\.bak$/, '').replace(/-\d+$/, '');
      const prev = newestBySource.get(source);
      const newer = !prev
        || f.mtimeMs > prev.mtimeMs
        || (f.mtimeMs === prev.mtimeMs && (f.date > prev.date
          || (f.date === prev.date && f.name > prev.name)));
      if (newer) newestBySource.set(source, f);
    }
    const protectedAbs = new Set([...newestBySource.values()].map((f) => f.abs));

    const totalBefore = files.reduce((sum, f) => sum + f.bytes, 0);
    const remove = [];
    let total = totalBefore;

    if (cutoff) {
      for (const f of files) {
        if (f.date >= cutoff) continue;
        if (protectedAbs.has(f.abs)) continue;
        remove.push(f);
        total -= f.bytes;
      }
    }
    if (maxTotalBytes > 0 && total > maxTotalBytes) {
      const removable = files
        .filter((f) => !protectedAbs.has(f.abs) && !remove.includes(f))
        .sort((a, b) => (a.date === b.date ? a.mtimeMs - b.mtimeMs : a.date < b.date ? -1 : 1));
      for (const f of removable) {
        if (total <= maxTotalBytes) break;
        remove.push(f);
        total -= f.bytes;
      }
    }

    const removed = [];
    if (!dryRun) {
      for (const f of remove) {
        try {
          fs.unlinkSync(f.abs);
          removed.push({ date: f.date, name: f.name, bytes: f.bytes });
        } catch (error) {
          errors.push(`${f.date}/${f.name}: ${String(error?.message ?? error)}`);
        }
      }
      for (const date of dirs) {
        try {
          const left = fs.readdirSync(path.join(root, date));
          if (left.length === 0) fs.rmdirSync(path.join(root, date));
        } catch {
          /* 目录被别人占用就留着 */
        }
      }
      if (removed.length > 0) {
        try {
          this.appendJsonl(this.pruneLogFile, {
            t: this.nowIso(),
            removed: removed.length,
            freedBytes: removed.reduce((sum, r) => sum + r.bytes, 0),
            keepDays,
            maxTotalBytes,
            today,
          }, { recordCorruption: false });
        } catch {
          /* 记不上不影响清理本身 */
        }
      }
    }
    return {
      dryRun,
      removed: dryRun ? remove.map((f) => ({ date: f.date, name: f.name, bytes: f.bytes })) : removed,
      kept: files.length - remove.length,
      freedBytes: remove.reduce((sum, f) => sum + f.bytes, 0),
      totalBefore,
      totalAfter: total,
      errors,
    };
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
      renameWithRetry(tmp, file);
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
      renameWithRetry(tmp, dest);
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
    return this.withLock(() => {
      const { rows, bad } = this.readJsonl(file, { recordCorruption: false });
      if (bad > 0 && record) this.noteCorruption(file, bad);
      const body = rows.map((r) => JSON.stringify(r));
      body.push(JSON.stringify(row));
      this.atomicWrite(file, `${body.join('\n')}\n`);
      return row;
    });
  }

  /**
   * 真追加：只往文件尾巴写一行，不重写既有内容。
   * 用于插件不拥有的文件（whale-undone.jsonl、whale-beliefs-log.jsonl），
   * 避免"读全量再重写"把既有坏行/并发写入的内容丢掉（S3）。
   */
  appendLine(file, row) {
    return this.withLock(() => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(file, 'a');
      try {
        fs.writeFileSync(fd, `${JSON.stringify(row)}\n`, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return row;
    });
  }

  /**
   * 跨进程互斥。DSH 一般单会话，但同一台机器开两个 profile /
   * 插件和 CLI 同时写同一本账，就会互相盖。
   *
   * 用 `<dataDir>/.lock` 独占创建；持有超过 staleMs 视为崩溃残留，抢过来。
   * 同步实现：guard 必须同步，所以这里用 Atomics.wait 小睡。
   * 同类重入按深度放行（appendJsonl 里会调 noteCorruption → 又写账）。
   */
  withLock(fn, options = {}) {
    const timeoutMs = options.timeoutMs ?? 3000;
    const staleMs = options.staleMs ?? 30000;
    if (this.lockDepth > 0) {
      this.lockDepth += 1;
      try {
        return fn();
      } finally {
        this.lockDepth -= 1;
      }
    }
    fs.mkdirSync(this.dataDir, { recursive: true });
    const started = Date.now();
    for (;;) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx');
        try {
          fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, t: Date.now() }), 'utf8');
        } finally {
          fs.closeSync(fd);
        }
        break;
      } catch (error) {
        // Windows 上「别人正持有/正在删」这个文件时，openSync('wx') 抛的常常是
        // EPERM/EACCES 而不是 EEXIST（CI 的 windows/node24 就是这么挂的）。
        // 这三种都当「锁已被占用」处理：查残留、等一等、再试。
        const busy = error && (error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'EACCES');
        if (!busy) throw error;
        let stale = false;
        try {
          stale = Date.now() - fs.statSync(this.lockPath).mtimeMs > staleMs;
        } catch {
          continue; // 刚被别人放掉，重试即可
        }
        if (stale) {
          try { fs.unlinkSync(this.lockPath); } catch { /* 别人先删了 */ }
          continue;
        }
        if (Date.now() - started > timeoutMs) {
          throw new Error(`等锁超时（${this.lockPath}，${timeoutMs}ms）`);
        }
        sleepSync(15);
      }
    }
    this.lockDepth = 1;
    try {
      return fn();
    } finally {
      this.lockDepth = 0;
      try { fs.unlinkSync(this.lockPath); } catch { /* 已被清掉 */ }
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

  /**
   * 今天账上有没有一笔（v0.3 S10）。
   * change / backup / 判断 / 错误 / 冲突，任一即算有；这是收工闸的触发条件。
   */
  todayHasEntries(today = this.today()) {
    const onDay = (row) => this.dateOf(row.t) === today;
    if (this.manifestRows().some((r) => onDay(r)
      && ['change', 'edit', 'create', 'backup', 'retired'].includes(r.kind))) return true;
    if (this.errorRows().some((r) => onDay(r) && r.type !== 'corrupt')) return true;
    if (this.readJsonl(this.criteriaLogFile, { recordCorruption: false }).rows.some(onDay)) return true;
    if (this.readJsonl(this.conflictsFile, { recordCorruption: false }).rows.some(onDay)) return true;
    return false;
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

  /**
   * @param {string} [today]
   * @param {{all?: string[], modified?: string[]}} [git] git 看到的改动（all＝含新建，modified＝已存在文件的改动）
   */
  counts(today = this.today(), git = {}) {
    const manifest = this.manifestRows().filter((r) => this.dateOf(r.t) === today);
    const editRows = manifest
      .filter((r) => r.kind === 'change' || r.kind === 'edit')
      .map((r) => r.path);
    // 改 = 当日动过的去重路径数；导入的备份行也贡献一个路径，
    // 否则历史导入会显示成“改0 备9”这种更假的账。
    const edited = new Set(
      manifest
        .filter(
          (r) => ['change', 'edit', 'create'].includes(r.kind)
            || (r.kind === 'backup' && r.imported),
        )
        .map((r) => r.path),
    );
    // 账本之外的证人（git）：改过但没经过插件的文件也要算进来，
    // 否则「改N」永远是账本自己给自己报的数。
    const fromGit = [];
    for (const p of Array.isArray(git?.all) ? git.all : []) {
      if (!p) continue;
      const abs = String(p);
      if (!edited.has(abs)) fromGit.push(abs);
      edited.add(abs);
    }
    const edits = edited.size;
    // 有改没备份：今天「改过已有文件」、但 manifest 里没有它的备份行。
    // 只看已存在文件的改动——新建文件本来没有原件，不该被算成漏备份。
    const backedUp = new Set(manifest.filter((r) => r.kind === 'backup').map((r) => r.path));
    const touched = [
      ...editRows,
      ...(Array.isArray(git?.modified) ? git.modified : []),
    ];
    const unbacked = [...new Set(touched)].filter((p) => !backedUp.has(p));
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
      byGit: fromGit.length, unbacked,
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
