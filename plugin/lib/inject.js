import path from 'node:path';

import { DAY_MS, sha256Text, truncate } from './store.js';
import { GATE_BYTES, findNewestSession, gateLine, readSession, sessionLine, trimmedLine } from './sessionwatch.js';
import { windowLine, windowState } from './clock.js';

/**
 * 每轮注入（S17/S18/S19）。
 * 尾部段（order=10300）、最多 5 行、24h 内不重复注入同一条未做。
 *
 * v0.6.10（2026-10-30）：加「会话闸」两行——常态报字节，到 800 KB 就置顶喊人。
 * 起因：那天撞了模型窗口，918 轮发不出去，最后靠裁日志救回来。主人定：
 * 读字节、闸 800 KB、砍到 30 轮。会话行永远在（1 行），其余照旧按需出现。
 */
export function createInjection(store, config = {}) {
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

      // ---- 窗（2026-10-31）：现在能不能说话 ----
      // 四窗见 自我\时间表.json 与 架构.md §16。表默认跟着 workspaceRoot 走，
      // 这样测试里的临时工作区读不到表 = 没有这一行，不会把真表带进单测。
      let windowRow = '';
      try {
        const table = config.clockTable
          || (config.workspaceRoot ? path.join(config.workspaceRoot, '自我', '时间表.json') : undefined);
        windowRow = table ? windowLine(windowState({ table })) : '';
      } catch {
        /* 没表 / 表坏了就当没有窗 */
      }

      // ---- 会话闸（v0.6.10）----
      // 只 stat，不解压：轮数要解 200 多帧，每轮都做太贵（主人 2026-10-30 定的）。
      const prevBytes = Number(state['session-bytes']) || 0;
      const sessionLines = [];
      let sessionBytes = 0;
      try {
        const session = readSession(config.dshHome, process.cwd(), config.cwd, config.workspaceRoot)
          ?? findNewestSession(config.dshHome);
        if (session) {
          sessionBytes = session.bytes;
          const trimmed = trimmedLine(prevBytes, session);
          if (trimmed) sessionLines.push(trimmed);
          if (session.bytes >= GATE_BYTES) {
            sessionLines.unshift(gateLine(session, { gate: GATE_BYTES, cutTurns: 30 }));
          } else {
            sessionLines.unshift(sessionLine(session, GATE_BYTES));
          }
        }
      } catch {
        /* 读不到会话就当没有这一行，不影响其余 */
      }

      const quiet = undone.length === 0 && (hasEvent || !store.sayDir) && errors < 3 && !turnHot && !stateHot;

      const nowMs = store.now().getTime();
      const fresh = [];
      if (!quiet) {
        for (const row of [...undone].reverse()) {
          const key = sha256Text(row.text);
          const last = Date.parse(String(state[key] ?? ''));
          if (!Number.isNaN(last) && nowMs - last < DAY_MS) continue;
          fresh.push({ key, text: truncate(row.text, 20) });
          if (fresh.length >= 4) break;
        }
      }

      const lines = [];
      if (!quiet) {
        const flag = errors >= 3 ? ` ⚠错误${errors}` : '';
        lines.push(
          `【账房】改${counts.edits} 备${counts.backups} | 今日事件：${store.sayDir ? (hasEvent ? '有' : '无') : '（未启用）'}${flag}`,
        );
        if (turnHot) lines.push(`· 上回合：改了${turnEdits}个文件，一笔账没记`);
        if (stateHot && lines.length < 4) {
          lines.push(`· 改过状态类文件（${stateFiles.slice(0, 2).join('、')}），状态页更新了吗？`);
        }
        for (const item of fresh) lines.push(`· 未做：${item.text}`);
        if (store.sayDir && !hasEvent && lines.length < 4) {
          lines.push(`· 今日还没有 ${store.sayDir}/${today}-*.md（发帖记录）`);
        }
        const zero = store.zeroRefRules(7).length;
        if (zero > 0 && lines.length < 4) lines.push(`· 近7天0引用的规矩：${zero} 条`);
      }

      const changedState = fresh.length > 0 || stateHot || sessionBytes > 0;
      if (changedState) {
        for (const item of fresh) state[item.key] = new Date(nowMs).toISOString();
        if (stateHot) state['state-warned'] = today; // 一天只提醒一次
        if (sessionBytes > 0) state['session-bytes'] = sessionBytes;
        const cutoff = nowMs - 7 * DAY_MS;
        for (const [key, value] of Object.entries(state)) {
          if (key === 'state-warned' || key === 'session-bytes') continue;
          const ms = Date.parse(String(value));
          if (Number.isNaN(ms) || ms < cutoff) delete state[key];
        }
        store.saveInjectState(state);
      }

      return [...(windowRow ? [windowRow] : []), ...sessionLines, ...lines].slice(0, 5).join('\n');
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
