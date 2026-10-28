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

      // a）上一回合改了文件却一笔账没记：这一轮才说（在回合内说已经晚了）。
      const turn = store.turnState() || {};
      const turnEdits = Number(turn.edits) | 0;
      const turnLedger = Number(turn.ledger) | 0;
      const turnHot = turnEdits > 0 && turnLedger === 0 && store.withinDays(turn.t, 1);

      // v0.5.3：上回合写过「状态类文件」（窗口/额度/版本），提醒一句去更新状态页。
      //   一天只提醒一次；只提醒，不校验状态页内容。
      const state = store.injectState();
      const stateFiles = Array.isArray(turn.stateFiles) ? turn.stateFiles.filter((n) => typeof n === 'string' && n) : [];
      const stateHot = stateFiles.length > 0 && store.withinDays(turn.t, 1) && state['state-warned'] !== today;

      if (undone.length === 0 && (hasEvent || !store.sayDir) && errors < 3 && !turnHot && !stateHot) return '';

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
      if (turnHot) lines.push(`· 上回合：改了${turnEdits}个文件，一笔账没记`);
      if (stateHot && lines.length < 5) {
        lines.push(`· 改过状态类文件（${stateFiles.slice(0, 2).join('、')}），状态页更新了吗？`);
      }
      for (const item of fresh) lines.push(`· 未做：${item.text}`);
      if (store.sayDir && !hasEvent && lines.length < 5) {
        lines.push(`· 今日还没有 ${store.sayDir}/${today}-*.md（发帖记录）`);
      }
      const zero = store.zeroRefRules(7).length;
      if (zero > 0 && lines.length < 5) lines.push(`· 近7天0引用的规矩：${zero} 条`);

      if (fresh.length > 0 || stateHot) {
        for (const item of fresh) state[item.key] = new Date(nowMs).toISOString();
        if (stateHot) state['state-warned'] = today; // 一天只提醒一次
        const cutoff = nowMs - 7 * DAY_MS;
        for (const [key, value] of Object.entries(state)) {
          if (key === 'state-warned') continue;
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
