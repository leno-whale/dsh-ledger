// sessionwatch.js —— 会话闸（2026-10-30）
//
// 为什么要有：2026-10-30 21:30 这个会话撞了模型窗口（918 轮 ≈ 906,775 tok，
// 加 256k 补全预算超过 1,048,576），整轮整轮发不出去；最后是另一个工作区的 leno
// 把日志裁到 30 轮才救回来。此后定下：**按字节看闸，到 800 KB 就该写交接信、
// 挂钟、请主人裁**。主人在 2026-10-30 明确：读字节，不读轮数（轮数要解压 200 多帧，
// 每轮都做太贵；字节一次 stat 就够）。
//
// 单位：字节（不换算 token）。闸 = GATE_BYTES。
import fs from 'node:fs';
import path from 'node:path';

// 2026-10-31 01:52 主人把闸从 800 KB 提到 2000 KB（原话：「现在把闸提到2000KB」）。
// 记一句实话：800 KB 是我按「谨慎」挑的，量过的是 267 KB（裁后）与 1 MB 出头（裁前）两档，
// 2 MB 这档没有实测样本。闸高了省事，离红线也更近——真撞了，就把数字改回来。
export const GATE_BYTES = 2000 * 1024;

/** `C:\Users\A\proj` → `--C-Users-A-proj--`（DSH 会话目录的编码规则） */
export function encodeProjectDir(cwd) {
  return `--${String(cwd).replace(/[:\\/]+/g, '-').replace(/-+$/, '')}--`;
}

/** 在 `<dshHome>/sessions/<编码目录>/<会话名>/session.v4.jsonl.zstd` 里挑最新的一个 */
export function findSessionFile(dshHome, cwd) {
  if (!dshHome || !cwd) return null;
  const base = path.join(dshHome, 'sessions', encodeProjectDir(cwd));
  let names;
  try {
    names = fs.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return null;
  }
  let best = null;
  for (const name of names) {
    const file = path.join(base, name, 'session.v4.jsonl.zstd');
    try {
      const st = fs.statSync(file);
      if (!best || st.mtimeMs > best.mtimeMs) best = { file, name, bytes: st.size, mtimeMs: st.mtimeMs };
    } catch {
      /* 这个会话没有日志，跳过 */
    }
  }
  return best;
}

/**
 * 读当前会话的字节数。只做 stat，不解压。
 *
 * 2026-10-31 修：不能再「按 cwd 顺序取第一个命中的」。GUI 进程的 cwd 是
 * `~\.dsh\profiles\desktop`，那个项目目录里躺着一份 13:31 的旧会话（175 KB），
 * 于是闸一直报 175 KB，而真正在写的那份已经 927 KB —— 仪器先坏，读数就没意义。
 * 现在的规矩：**谁最近还在写，就是谁**。cwd 命中只是候选之一，mtime 说了算；
 * 全都超过新鲜窗口时，才退回按 cwd 命中的那份（项目对得上，只是这会儿没人写）。
 */
export function readSession(dshHome, ...cwds) {
  const nowMs = Date.now();
  const fresh = 30 * 60 * 1000;
  const candidates = [];
  for (const cwd of cwds) {
    if (!cwd) continue;
    const found = findSessionFile(dshHome, cwd);
    if (found) candidates.push({ ...found, fromCwd: true });
  }
  const newest = pickNewestSession(dshHome);
  if (newest) candidates.push({ ...newest, fromCwd: false });
  if (!candidates.length) return null;

  const freshOnes = candidates.filter((c) => nowMs - c.mtimeMs <= fresh);
  if (freshOnes.length) {
    return freshOnes.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  }
  const byCwd = candidates.filter((c) => c.fromCwd).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  return byCwd ?? null;
}

/**
 * 兜底：cwd 一个都对不上时（插件进程的 cwd 常是宿主目录，不是会话工作区），
 * 就在 `<dshHome>/sessions/* / * /session.v4.jsonl.zstd` 里挑 mtime 最新的一份。
 * 但只认「最近还在写」的（默认 30 分钟内），否则宁可报读不到，也不拿别人的会话凑数。
 */
export function findNewestSession(dshHome, { withinMs = 30 * 60 * 1000, nowMs = Date.now() } = {}) {
  const best = pickNewestSession(dshHome);
  if (!best) return null;
  return nowMs - best.mtimeMs <= withinMs ? best : null;
}

/** 全盘挑 mtime 最新的那份会话日志（不做新鲜度判断） */
export function pickNewestSession(dshHome) {
  const base = path.join(dshHome, 'sessions');
  let projects;
  try {
    projects = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null;
  }
  let best = null;
  for (const project of projects) {
    const projectDir = path.join(base, project.name);
    let sessions;
    try {
      sessions = fs.readdirSync(projectDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const one of sessions) {
      const file = path.join(projectDir, one.name, 'session.v4.jsonl.zstd');
      try {
        const st = fs.statSync(file);
        if (!best || st.mtimeMs > best.mtimeMs) {
          best = { file, name: one.name, bytes: st.size, mtimeMs: st.mtimeMs };
        }
      } catch {
        /* 这个会话没有日志 */
      }
    }
  }
  return best;
}

/** 一行状态（常态） */
export function sessionLine(session, gate = GATE_BYTES) {
  if (!session) return '';
  return `【会话】${Math.round(session.bytes / 1024)} KB / 闸 ${Math.round(gate / 1024)} KB`;
}

/** 到闸那行：写成动作，不写成状态（状态会被当背景，动作才会被做） */
export function gateLine(session, { gate = GATE_BYTES, cutTurns = 30 } = {}) {
  if (!session) return '';
  return `【会话·到闸】${Math.round(session.bytes / 1024)} KB ≥ ${Math.round(gate / 1024)} KB → 这一轮先说三件：`
    + `①写交接信（ledger_handoff letter）②挂 5 分钟钟（schedule_create after_seconds=300）`
    + `③请主人退出 GUI 跑 trim-session --turns=${cutTurns} --install`;
}

/** 刚裁过：上一轮记的字节比现在大一截 */
export function trimmedLine(prevBytes, session, { ratio = 0.7 } = {}) {
  if (!session || !prevBytes || prevBytes <= 0) return '';
  if (session.bytes >= prevBytes * ratio) return '';
  return `【交接】刚裁过（${Math.round(prevBytes / 1024)}→${Math.round(session.bytes / 1024)} KB）：`
    + '先读 自我\\归档\\ 里最新那封交接信，读完在末尾写回信';
}
