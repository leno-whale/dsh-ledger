// session-target.js —— 指定会话触发（v0.7.0 / 2026-10-31）
//
// 为什么要有：
//   0.6.10 的会话闸靠 cwd / mtime 猜「哪一份会话是我的」，0.6.15 又把宿主目录挡在外面。
//   但「猜」本身还在：同一个宿主进程里同时跑着几个会话时，账房照样给每个会话写 L1、
//   每个会话都敲收工闸。2026-10-31 已经记过一句——**仪器指错了人，比仪器坏了更难发现**。
//
// 现在改成**点名**：配置 `sessions` 为空＝照旧（所有会话都管）；写了就只认这些会话。
// 值为会话 id，支持 `*` 通配（例：`main-*`）。
//
// id 从哪来（核对过宿主源码，不是猜的）：
//   `@deepseek-ai/dsh-agent` 的 `assembleContextFor(agent)` 返回 `{ agent, scope: agent }`，
//   组装提示词时 `section.text(context)` 拿到的就是它；`agent.session.id` 即会话 id
//   （同文件里 `if (id !== agent.session.id) throw ...` 说明 agent id 与会话 id 相同）。
//   `agent/turn-stopping` 的 payload 里同样带 `agent`。

/** 从 context / payload / agent 里挖会话 id；挖不到返回空串（不抛） */
export function sessionIdOf(source) {
  if (typeof source === 'string') return source.trim();
  const candidates = [
    source?.agent?.session?.id,
    source?.agent?.sessionId,
    source?.agent?.id,
    source?.session?.id,
    source?.sessionId,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

/** 会话 id 与一条点名是否相符：精确比，或 `*` 通配 */
export function matchSession(id, pattern) {
  const target = String(pattern ?? '').trim();
  const value = String(id ?? '').trim();
  if (!value || !target) return false;
  if (!target.includes('*')) return value === target;
  const rx = new RegExp(`^${target.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return rx.test(value);
}

/**
 * 这个会话要不要管。
 * @param sessions 配置里的点名表；空＝全部会话（向后兼容）
 * @param id 当前会话 id；空＝认不出
 * @param unknown `run`（默认，认不出就照旧管）或 `skip`（认不出一律不管）
 */
export function isTargeted(sessions, id, { unknown = 'run' } = {}) {
  const list = Array.isArray(sessions)
    ? sessions.filter((s) => typeof s === 'string' && s.trim() !== '')
    : [];
  if (list.length === 0) return true;
  if (!id) return unknown !== 'skip';
  return list.some((pattern) => matchSession(id, pattern));
}

/** 一行说明，给账/错误账用 */
export function describeTargets(sessions) {
  const list = Array.isArray(sessions)
    ? sessions.filter((s) => typeof s === 'string' && s.trim() !== '')
    : [];
  return list.length ? list.join(', ') : '全部会话';
}
