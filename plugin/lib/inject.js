import { DAY_MS, sha256Text, truncate } from './store.js';

/**
 * 每轮注入（S17/S18/S19）。
 * 尾部段（order=9500）、最多 5 行、24h 内不重复注入同一条未做；
 * 三项都正常（无未做、今日有事件、错误<3）时返回空字符串，让该段消失。
 */
export function createInjection(store) {
  return function lenoLedgerPromptSection() {
    try {
      if (store.config && store.config.inject === false) return '';
      const today = store.today();
      const counts = store.counts(today);
      const hasEvent = store.hasEventFile(today);
      const undone = store.undoneRows().filter(
        (row) => typeof row.text === 'string' && row.text !== '' && store.withinDays(row.t, 7),
      );
      const errors = store.unresolvedErrors().length;

      if (undone.length === 0 && (hasEvent || !store.sayDir) && errors < 3) return '';

      const state = store.injectState();
      const nowMs = store.now().getTime();
      const fresh = [];
      for (const row of [...undone].reverse()) {
        const key = sha256Text(row.text);
        const last = Date.parse(String(state[key] ?? ''));
        if (!Number.isNaN(last) && nowMs - last < DAY_MS) continue;
        fresh.push({ key, text: truncate(row.text, 20) });
        if (fresh.length >= 4) break;
      }

      const flag = errors >= 3 ? ` ⚠错误${errors}` : '';
      const lines = [
        `【账房】改${counts.edits} 备${counts.backups} | 今日事件：${store.sayDir ? (hasEvent ? '有' : '无') : '（未启用）'}${flag}`,
      ];
      for (const item of fresh) lines.push(`· 未做：${item.text}`);
      if (store.sayDir && !hasEvent && lines.length < 5) {
        lines.push(`· 今日还没有 ${store.sayDir}/${today}-*.md，收工会被拦`);
      }
      const zero = store.zeroRefRules(7).length;
      if (zero > 0 && lines.length < 5) lines.push(`· 近7天0引用的规矩：${zero} 条`);

      if (fresh.length > 0) {
        for (const item of fresh) state[item.key] = new Date(nowMs).toISOString();
        const cutoff = nowMs - 7 * DAY_MS;
        for (const [key, value] of Object.entries(state)) {
          const ms = Date.parse(String(value));
          if (Number.isNaN(ms) || ms < cutoff) delete state[key];
        }
        store.saveInjectState(state);
      }

      return lines.slice(0, 5).join('\n');
    } catch (error) {
      try {
        store.recordError({
          text: `注入段内部异常，已返回空段：${error?.message ?? error}`,
          source: 'inject',
          level: 'P1',
        });
      } catch {
        /* 空段 */
      }
      return '';
    }
  };
}
