import fs from 'node:fs';
import path from 'node:path';

import { matchIgnore, stateFileOf } from './config.js';

function isoOf(stat) {
  return new Date(stat.mtimeMs).toISOString();
}

/**
 * 备份闸（S10/S11/S12）。
 * - 只拦 write / edit（本版本没有 multi_edit）。
 * - 目标不存在：放行，manifest 记 kind:create。
 * - 目标存在且 size>0：当日已有同 sha256 备份 -> 放行；
 *   否则 autoBackup=true 先备份再放行，false 返回拒绝理由。
 * - 任何内部异常都放行并写错误账（S15）。
 */
export function createBackupGuard({ store, config, notes }) {
  return function lenoLedgerBackupGuard(exec) {
    try {
      const toolName = exec?.name;
      if (toolName !== 'write' && toolName !== 'edit') return undefined;
      const args = exec?.arguments;
      const rawPath = args && typeof args === 'object' ? args.file_path : undefined;
      if (typeof rawPath !== 'string' || rawPath.trim() === '') return undefined;

      const abs = path.resolve(rawPath.trim());
      // 忽略清单：密钥、依赖目录、二进制等直接不管（config.ignore）
      if (matchIgnore(abs, config.ignore)) return undefined;
      if (!fs.existsSync(abs)) {
        store.appendManifest({ path: abs, kind: 'create', sha256: '', size: 0, mtime: '' });
        return undefined;
      }

      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size === 0) return undefined;
      // 体积上限：超过 maxBackupBytes 的不备份（也不拦，README 有说明）
      if (Number.isFinite(config.maxBackupBytes) && stat.size > config.maxBackupBytes) {
        return undefined;
      }

      const sha256 = store.sha256File(abs);
      const mtime = isoOf(stat);
      const today = store.today();
      const backed = store.findTodayBackup(abs, sha256, today);

      if (backed) {
        store.appendManifest({
          path: abs, kind: 'change', sha256, size: stat.size, mtime,
          source: 'gate', backup: backed.backup,
        });
        return undefined;
      }

      if (config.autoBackup) {
        let backupPath = '';
        try {
          const result = store.backupFile(abs);
          backupPath = result.backupPath;
          notes.set(
            exec,
            `leno-ledger: 已自动备份 ${abs} -> ${result.backupPath}（sha256 ${result.sha256.slice(0, 12)}）`,
          );
        } catch (error) {
          store.recordError({
            text: `自动备份失败，已放行：${error?.message ?? error}`,
            source: 'backup-gate',
            level: 'P0',
            ref: abs,
          });
        }
        store.appendManifest({
          path: abs, kind: 'change', sha256, size: stat.size, mtime,
          source: 'gate', backup: backupPath,
        });
        return undefined;
      }

      return [
        'leno-ledger: 未备份。',
        `write/edit 将改动已存在文件 ${abs}（${stat.size} 字节，sha256 ${sha256.slice(0, 12)}），`,
        '当日 manifest 里没有该内容指纹的备份记录。',
        `先调用：ledger_backup {"file_path":${JSON.stringify(abs)}}`,
        '（autoBackup=false 时硬拒绝；设为 true 可自动备份后放行。）',
      ].join('\n');
    } catch (error) {
      try {
        store.recordError({
          text: `备份闸内部异常，已放行：${error?.message ?? error}`,
          source: 'backup-gate',
          level: 'P0',
        });
      } catch {
        /* 错误账不可写时保持放行 */
      }
      return undefined;
    }
  };
}

/**
 * 收工闸（v0.3 S10）。
 * 触发条件：今天账上一笔都没有（change/backup/判断/错误/冲突任一即算有），
 * 不再以「事件文件」为准——发不发帖和有没有干活是两回事。
 * 仍用 agent.steer 把“下一步”塞回 inbox（不是 abort/抛错），
 * 同一 turn 只敲一次，两次 steer 之间至少间隔 minIntervalMs（默认 1 小时）。
 */
export function createTurnStopper({ store, config, now = () => Date.now(), stats = null }) {
  // 2026-10-27：顺手写一行心跳，给别的插件（bili-whale 的「N 天没表态」）用。
  //   只写时间戳，不参与账目；写失败不算错，也不影响下面任何判断。
  try {
    const hb = path.join(config.dshHome, "ledger-heartbeat.json");
    fs.mkdirSync(path.dirname(hb), { recursive: true });
    fs.writeFileSync(hb, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid })}\n`, "utf8");
  } catch { /* 心跳写不了不算错 */ }
  const steeredTurns = new Set();
  let lastSteerAt = 0;
  return function lenoLedgerTurnStopping(payload) {
    try {
      const agent = payload?.agent;
      const turn = payload?.turn;
      const today = store.today();

      // a）先记账再判要不要 steer：本回合改了文件却一笔账没记，留给下一轮注入去说。
      if (stats) {
        const edits = Number(stats.edits) | 0;
        const ledger = Number(stats.ledger) | 0;
        const stateFiles = Array.isArray(stats.stateFiles) ? stats.stateFiles.slice(0, 4) : [];
        if (edits > 0 || ledger > 0 || stateFiles.length > 0) {
          store.saveTurnState({ t: store.nowIso(), edits, ledger, stateFiles });
        }
        stats.edits = 0;
        stats.ledger = 0;
        stats.stateFiles = [];
      }

      if (store.todayHasEntries(today)) return;
      if (store.todaySkips(today) > 0) return;

      const key = String(turn ?? `day:${today}`);
      if (steeredTurns.has(key)) return;
      const interval = Number.isFinite(config.minIntervalMs) ? config.minIntervalMs : 0;
      if (lastSteerAt > 0 && now() - lastSteerAt < interval) return;

      steeredTurns.add(key);

      if (!agent || typeof agent.steer !== 'function') {
        store.recordError({
          text: '收工闸：payload 里没有可 steer 的 agent，已放行',
          source: 'turn-gate',
          level: 'P1',
        });
        return;
      }

      const remaining = Math.max(0, config.maxSkipsPerDay - store.todaySkips(today));
      const sayHint = store.sayDir ? `，或写 ${path.join(store.sayDir, `${today}-NN.md`)}` : '';
      const action = remaining > 0
        ? `下一步（三选一）：A) 改一个文件（自动记 change+backup）；B) 记一条判断/错误/分歧${sayHint}；C) 确实今天没干活，调用 ledger_error {"text":"原因","skip_check":true} 跳过今日检查（今日还剩 ${remaining} 次）。`
        : `下一步：改一个文件、记一条判断/错误/分歧${sayHint}。今日跳过次数已用完（maxSkipsPerDay=${config.maxSkipsPerDay}），不能再跳过。`;

      agent.steer({
        id: store.randomId(),
        role: 'user',
        content: [{ type: 'text', text: `leno-ledger: 收工未记账。${action}` }],
        source: { kind: 'leno-ledger' },
      });
      lastSteerAt = now();
    } catch (error) {
      try {
        store.recordError({
          text: `收工闸内部异常，已放行：${error?.message ?? error}`,
          source: 'turn-gate',
          level: 'P0',
        });
      } catch {
        /* 放行 */
      }
    }
  };
}

/**
 * 自动备份后的可见提示（S11）：把一行说明追加到该次 write/edit 的结果内容里。
 * 结构依据 _probe/tools-types.js:1152-1189 的 tools/post-execute waterfall。
 */
export function createPostExecute(notes, stats = null) {
  return async function lenoLedgerPostExecute(exec, result, next) {
    const note = notes.get(exec);
    if (note) notes.delete(exec);
    const decision = typeof next === 'function' ? await next() : { kind: 'accept' };
    if (stats) {
      try {
        const name = String(exec?.name ?? '');
        const ok = !(result && result.isError);
        const isWrite = name === 'write' || name === 'edit' || name.endsWith('_edit');
        if (ok && isWrite) {
          stats.edits += 1;
          // v0.5.3：写的是「状态类文件」（配置/版本/窗口）就记下来，下轮注入提醒一句。
          const hit = stateFileOf(exec?.arguments?.file_path);
          if (hit) {
            if (!Array.isArray(stats.stateFiles)) stats.stateFiles = [];
            if (!stats.stateFiles.includes(hit)) stats.stateFiles.push(hit);
          }
        } else if (ok && name.startsWith('ledger_')) stats.ledger += 1;
      } catch {
        /* 计数失败不影响执行 */
      }
    }
    if (!note || !result || result.isError) return decision;
    if (!decision || decision.kind !== 'accept') return decision;
    if (Object.hasOwn(decision, 'value')) return decision;
    const content = Array.isArray(decision.content)
      ? decision.content
      : Array.isArray(result.content) ? result.content : [];
    return { ...decision, content: [...content, { type: 'text', text: note }] };
  };
}
