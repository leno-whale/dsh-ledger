import fs from 'node:fs';
import path from 'node:path';

import { matchIgnore } from './config.js';

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
        store.appendManifest({ path: abs, kind: 'edit', sha256, size: stat.size, mtime });
        return undefined;
      }

      if (config.autoBackup) {
        try {
          const result = store.backupFile(abs);
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
        store.appendManifest({ path: abs, kind: 'edit', sha256, size: stat.size, mtime });
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
 * 收工闸（S14）。
 * turn-stopping 阶段用 agent.steer 把“下一步”塞回 inbox，回合会再走一步；
 * 不用 abort/抛错（那会把回合标成 error）。同一 turn 最多 steer 一次，防死循环（S15）。
 */
export function createTurnStopper({ store, config }) {
  const steeredTurns = new Set();
  return function lenoLedgerTurnStopping(payload) {
    try {
      const agent = payload?.agent;
      const turn = payload?.turn;
      const today = store.today();

      if (!store.sayDir) return; // 没配置事件目录＝收工闸关着（默认）
      if (store.hasEventFile(today)) return;
      if (store.todaySkips(today) > 0) return;

      const key = String(turn ?? `day:${today}`);
      if (steeredTurns.has(key)) return;
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
      const eventExample = path.join(store.sayDir, `${today}-NN.md`);
      const action = remaining > 0
        ? `下一步（二选一）：A) 写 ${eventExample}（五栏：场/谁在收/几个人在看/接法/判读）；B) 确实不记，调用 ledger_error {"text":"原因","skip_check":true} 跳过今日检查（今日还剩 ${remaining} 次）。`
        : `下一步：写 ${eventExample}。今日跳过次数已用完（maxSkipsPerDay=${config.maxSkipsPerDay}），不能再跳过。`;

      agent.steer({
        id: store.randomId(),
        role: 'user',
        content: [{ type: 'text', text: `leno-ledger: 收工未记账。${action}` }],
        source: { kind: 'leno-ledger' },
      });
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
export function createPostExecute(notes) {
  return async function lenoLedgerPostExecute(exec, result, next) {
    const note = notes.get(exec);
    if (note) notes.delete(exec);
    const decision = typeof next === 'function' ? await next() : { kind: 'accept' };
    if (!note || !result || result.isError) return decision;
    if (!decision || decision.kind !== 'accept') return decision;
    if (Object.hasOwn(decision, 'value')) return decision;
    const content = Array.isArray(decision.content)
      ? decision.content
      : Array.isArray(result.content) ? result.content : [];
    return { ...decision, content: [...content, { type: 'text', text: note }] };
  };
}
