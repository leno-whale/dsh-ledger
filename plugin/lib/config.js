import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 数据文件名（放在 dataDir 里；沿用 leno 时代的名字，v0.4 再改名并做迁移） */
export const FILES = Object.freeze({
  manifest: 'ledger-manifest.jsonl',
  errors: 'ledger-errors.jsonl',
  criteriaDir: 'ledger-criteria',
  ruleUsage: 'ledger-rule-usage.json',
  criteriaLog: 'ledger-criteria-log.jsonl',
  beliefs: 'whale-beliefs.md',
  beliefsLog: 'whale-beliefs-log.jsonl',
  undone: 'whale-undone.jsonl',
  conflicts: 'ledger-conflicts.jsonl',
  injectState: 'ledger-inject-state.json',
  turnState: 'ledger-turn.json',
  pruneLog: 'ledger-prune-log.jsonl'
});

/**
 * v0.3 及以前的文件名 → 现在的名字。
 * 只搬插件自己拥有的文件；`whale-beliefs.md` / `whale-beliefs-log.jsonl` /
 * `whale-undone.jsonl` 是使用者自己的本子，保持原名（要改走 config 覆盖）。
 */
export const LEGACY_NAMES = Object.freeze({
  'whale-backup-manifest.jsonl': FILES.manifest,
  'whale-error-ledger.jsonl': FILES.errors,
  'whale-criteria': FILES.criteriaDir,
  'whale-rule-usage.json': FILES.ruleUsage,
  'whale-criteria-log.jsonl': FILES.criteriaLog,
  'whale-conflicts.jsonl': FILES.conflicts,
  'whale-inject-state.json': FILES.injectState
});

/**
 * 状态类文件（v0.5.3）：改了它们，说明「我的运行参数/窗口/额度」变了。
 * 注入段会提醒一句「状态页更新了吗」——只提醒，不校验内容（插件看得见路径，看不见对错）。
 */
export const STATE_FILE_PATTERNS = Object.freeze([
  /bili-whale\.config\.json$/i,
  /[\\/]profiles[\\/]desktop[\\/]package\.json$/i,
  /[\\/]dsh-bili-whale[\\/]lib[\\/]scheduler\.js$/i,
  /[\\/](?:dsh-leno-ledger|dsh-ledger)[\\/]plugin[\\/]package\.json$/i,
]);

/** 这个路径算不算「状态类文件」；算就返回文件名（给提示用），不算返回空串 */
export function stateFileOf(filePath) {
  const p = String(filePath ?? '').replace(/\\/g, '/');
  if (!p) return '';
  for (const re of STATE_FILE_PATTERNS) {
    if (re.test(p)) return p.slice(p.lastIndexOf('/') + 1);
  }
  return '';
}

/** 默认忽略：跑备份闸时直接跳过（`fnmatch` 语义的极简子集：`*` 只匹配一段） */
export const DEFAULT_IGNORE = Object.freeze([
  '.git',
  '.svn',
  'node_modules',
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa',
  'id_rsa.*',
  'id_ed25519',
  'id_ed25519.*',
  '.npmrc',
  'credentials.json'
]);

/**
 * 缺省配置。
 * 原则：**没有配置时只做「备份 + 记账」**，任何会 steer / 拦回合的功能都关着。
 * 报告里必须原样写出这几个默认值。
 */
export const DEFAULTS = Object.freeze({
  dshHome: path.join(os.homedir(), '.dsh'),
  /** 老式布局的根（`<root>/接口/说`）。默认空＝不启用「说/收工」相关功能。 */
  workspaceRoot: '',
  /** 收工闸看的目录；空＝不启用收工闸。 */
  sayDir: '',
  /** 规矩目录；空＝规矩清单为空。 */
  rulesDir: '',
  autoBackup: true,
  maxSkipsPerDay: 3,
  /** null＝跟随系统时区 */
  timeZone: null,
  /** 每轮把账注入系统提示；关掉后只能用 ledger_today 手动查 */
  inject: true,
  /** 单文件备份上限 */
  maxBackupBytes: 10 * 1024 * 1024,
  /** 备份保留天数（0＝不按时间清理） */
  backupKeepDays: 30,
  /** 备份总量上限，MB（0＝不按容量清理） */
  backupMaxTotalMb: 500,
  /** 备份时跳过的路径（子串或 `*` 通配） */
  ignore: DEFAULT_IGNORE,
  /** v0.4 用：要从 git 独立取「改了没备份」的仓库根 */
  watchRepos: [],
  /** 收工闸两次 steer 的最小间隔（毫秒），默认 1 小时 */
  minIntervalMs: 60 * 60 * 1000
});

const BOOL_TRUE = new Set(['1', 'true', 'yes', 'on']);
const BOOL_FALSE = new Set(['0', 'false', 'no', 'off']);

function asBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const key = String(value).trim().toLowerCase();
  if (BOOL_TRUE.has(key)) return true;
  if (BOOL_FALSE.has(key)) return false;
  return fallback;
}

function asPositiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (Number.isInteger(n) && n >= 0) return n;
  return fallback;
}

function asNonEmptyString(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function asStringArray(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') {
    const parts = value.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts : fallback;
  }
  if (Array.isArray(value)) {
    const parts = value.filter((s) => typeof s === 'string' && s.trim() !== '').map((s) => s.trim());
    return parts.length ? parts : fallback;
  }
  return fallback;
}

/** 系统时区；拿不到就退回 UTC（不写死上海） */
export function systemTimeZone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && tz ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

/** 老式散落账本是否在 dshHome 根上（决定默认 dataDir，避免把已有账丢下） */
function hasLegacyData(home) {
  // 两种「老」都算：v0.3 的 whale-* 名字，和已经搬到新名字的散落账。
  const names = [...Object.values(FILES), ...Object.keys(LEGACY_NAMES)];
  return names.some((name) => fs.existsSync(path.join(home, name)));
}

/**
 * 合并插件配置。
 * 优先级：显式 config > 环境变量（DSH_HOME / LENO_LEDGER_AUTO_BACKUP）> DEFAULTS。
 * 相对路径按 process.cwd() 解析成绝对路径（S8）。
 */
export function resolveConfig(raw = {}) {
  const env = process.env;
  const input = raw && typeof raw === 'object' ? raw : {};

  const dshHome = path.resolve(
    asNonEmptyString(input.dshHome, asNonEmptyString(env.DSH_HOME, DEFAULTS.dshHome))
  );

  // 数据目录：显式给了就用；否则**已经有老账就留在根上**，新用户用子目录。
  let dataDir = input.dataDir ? path.resolve(String(input.dataDir)) : '';
  if (!dataDir) {
    const candidate = path.join(dshHome, 'ledger');
    dataDir = fs.existsSync(candidate) || !hasLegacyData(dshHome) ? candidate : dshHome;
  }

  const workspaceRoot = input.workspaceRoot
    ? path.resolve(String(input.workspaceRoot))
    : DEFAULTS.workspaceRoot;

  // 老式布局兼容：给了 workspaceRoot 就按 `接口/说`、`接口/规矩` 推；
  // 否则用显式的 sayDir/rulesDir；都没给＝这些功能关着。
  const legacySay = workspaceRoot ? path.join(workspaceRoot, '接口', '说') : '';
  const legacyRules = workspaceRoot ? path.join(workspaceRoot, '接口', '规矩') : '';
  const sayDir = input.sayDir ? path.resolve(String(input.sayDir)) : legacySay;
  const rulesDir = input.rulesDir ? path.resolve(String(input.rulesDir)) : legacyRules;

  return {
    dshHome,
    dataDir,
    backupRoot: input.backupRoot
      ? path.resolve(String(input.backupRoot))
      : path.join(dshHome, 'backup'),
    beliefsFile: input.beliefsFile
      ? path.resolve(String(input.beliefsFile))
      : path.join(dataDir, FILES.beliefs),
    workspaceRoot,
    sayDir,
    rulesDir,
    autoBackup: asBool(
      input.autoBackup,
      asBool(env.LENO_LEDGER_AUTO_BACKUP, asBool(env.LEDGER_AUTO_BACKUP, DEFAULTS.autoBackup))
    ),
    maxSkipsPerDay: asPositiveInt(input.maxSkipsPerDay, DEFAULTS.maxSkipsPerDay),
    timeZone: asNonEmptyString(input.timeZone, asNonEmptyString(env.TZ, systemTimeZone())),
    inject: asBool(input.inject, DEFAULTS.inject),
    maxBackupBytes: asPositiveInt(input.maxBackupBytes, DEFAULTS.maxBackupBytes),
    backupKeepDays: asPositiveInt(input.backupKeepDays, DEFAULTS.backupKeepDays),
    backupMaxTotalMb: asPositiveInt(input.backupMaxTotalMb, DEFAULTS.backupMaxTotalMb),
    ignore: asStringArray(input.ignore, DEFAULTS.ignore),
    watchRepos: asStringArray(input.watchRepos, DEFAULTS.watchRepos),
    minIntervalMs: asPositiveInt(input.minIntervalMs, DEFAULTS.minIntervalMs)
  };
}

/** 极简 glob：`*` 匹配任意非分隔符段，其余按字面比；同时支持不含通配符的「路径里出现该片段」 */
export function matchIgnore(absPath, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  const norm = String(absPath).replace(/\\/g, '/');
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  for (const raw of patterns) {
    const p = String(raw).replace(/\\/g, '/').trim();
    if (!p) continue;
    if (!p.includes('*')) {
      if (norm.split('/').includes(p) || base === p) return true;
      continue;
    }
    const rx = new RegExp(`^${p.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    if (rx.test(base)) return true;
  }
  return false;
}
