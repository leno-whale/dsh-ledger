import path from 'node:path';

import { collectGitChanges } from './git.js';
import { truncate } from './store.js';

/**
 * `ledger_today` 的第一行（S9）。
 * 工具和离线 CLI 都走这里，避免两处格式/口径漂移。
 * `opts.git` 可注入已经算好的 git 结果；不传则按 config.watchRepos 现算。
 */
export function todayFirstLine(store, config, opts = {}) {
  const today = opts.today ?? store.today();
  const git = opts.git ?? collectGitChanges(config, today);
  const counts = store.counts(today, git);
  const hasEvent = store.hasEventFile(today);
  const importedNote = counts.imported > 0 ? `（含${counts.imported}导入）` : '';
  const totalErrors = store.unresolvedErrors().length;
  const line = `改${counts.edits} 备${counts.backups}${importedNote}`
    + ` | 判断${counts.judged} 记${counts.errors}`
    + ` | 冲突${counts.conflicts}`
    + ` | 今日事件：${hasEvent ? '有' : '无'}`;
  return line + (totalErrors >= 3 ? ` ⚠错误${totalErrors}` : '');
}

function rowTime(row) {
  const ms = Date.parse(String(row?.t ?? ''));
  return Number.isNaN(ms) ? 0 : ms;
}

/** 最近一条账（status.mjs 用）：跨 manifest / errors / conflicts / criteria-log 取最大 t。 */
export function latestLedgerEntry(store) {
  const entries = [];

  for (const row of store.manifestRows()) {
    const kind = String(row.kind ?? 'row');
    const where = path.basename(String(row.path ?? ''));
    const backup = row.backup ? ` -> ${path.basename(String(row.backup))}` : '';
    entries.push({ t: row.t, type: kind, summary: `${where}${backup}` });
  }
  for (const row of store.errorRows({ all: true })) {
    entries.push({ t: row.t, type: String(row.type ?? 'error'), summary: truncate(String(row.text ?? ''), 60) });
  }
  for (const row of store.readJsonl(store.conflictsFile, { recordCorruption: false }).rows) {
    entries.push({ t: row.t, type: 'conflict', summary: truncate(String(row.topic ?? ''), 60) });
  }
  for (const row of store.readJsonl(store.criteriaLogFile, { recordCorruption: false }).rows) {
    entries.push({
      t: row.t,
      type: String(row.event ?? 'judge'),
      summary: truncate(`${row.id ?? ''} ${row.why ?? row.title ?? ''}`.trim(), 60),
    });
  }

  entries.sort((a, b) => rowTime(b) - rowTime(a));
  return entries[0] ?? null;
}
