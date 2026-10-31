// clock.js —— 四窗（2026-10-31）
//
// 为什么要有：主人给了四窗——交互窗（工作日 12:00–14:00、18:00–23:30；周末 08:00–23:30）、
// 自醒窗（每天 01:00–03:00）、静默（其余时间）。窗不是新加一节，是 §8 的定义域：
//   𝒜_t = {a ∈ 𝒜 : Θ_a(t) = 1}，Θ_a(t) = 1 ⟺ t ∈ W(a)
// 见 `F:\agent expore\自我\架构.md` §16。
//
// 一份定义，两处用：注入段（让人看见现在能不能说话）与 gh-say.mjs（真的拦）。
// 表在 `自我\时间表.json`，改表就是改规矩——不要在代码里写第二份。
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_TABLE = 'F:\\agent expore\\自我\\时间表.json';

/** 把 "HH:MM" 换成分钟数 */
export function toMin(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (Number(h) || 0) * 60 + (Number(m) || 0);
}

/** 分钟数换回 "HH:MM" */
export function showMin(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

export function isWeekend(date = new Date()) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

/** 读表。读不到返回 null（调用方要能容忍：没表就当没窗，别崩注入段）。 */
export function loadTable(file = DEFAULT_TABLE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/**
 * 现在处在哪个窗。
 * 返回 { kind: 'interact' | 'wake' | 'quiet', weekend, windows, quota, nextOpen, leftMin }
 */
export function windowState({ table = DEFAULT_TABLE, now = new Date() } = {}) {
  const t = typeof table === 'string' ? loadTable(table) : table;
  if (!t) return { kind: 'quiet', weekend: isWeekend(now), windows: [], quota: null, nextOpen: null, leftMin: -1 };

  const weekend = isWeekend(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const rows = (t.interact?.[weekend ? 'weekend' : 'weekday'] ?? [['11:00', '23:00']]).map(([a, b]) => [toMin(a), toMin(b)]);
  const wakeRows = (t.wake?.daily ?? [['01:00', '03:00']]).map(([a, b]) => [toMin(a), toMin(b)]);
  const quota = Number(t.quota?.[weekend ? 'weekend' : 'weekday'] ?? 0) || null;

  const hit = (list) => list.find(([a, b]) => nowMin >= a && nowMin < b) ?? null;

  const inInteract = hit(rows);
  const inWake = hit(wakeRows);
  const kind = inInteract ? 'interact' : inWake ? 'wake' : 'quiet';
  const leftMin = inInteract ? inInteract[1] - nowMin : inWake ? inWake[1] - nowMin : -1;

  // 下一个开窗：今天剩下的交互窗，否则明天的第一段
  let nextOpen = null;
  for (const [a] of rows) if (nowMin < a) { nextOpen = `今天 ${showMin(a)}`; break; }
  if (!nextOpen) {
    const tomorrow = new Date(now.getTime() + 86400000);
    const tRows = t.interact?.[isWeekend(tomorrow) ? 'weekend' : 'weekday'] ?? [['11:00', '23:00']];
    nextOpen = `明天 ${tRows[0][0]}`;
  }

  return { kind, weekend, windows: rows, quota, nextOpen, leftMin, wakeRows };
}

/** 注入段那一行（短，一行说完：现在能不能说话） */
export function windowLine(state) {
  if (!state) return '';
  if (state.kind === 'interact') {
    return `【窗】${state.weekend ? '周末' : '工作日'} 交互中｜还有 ${state.leftMin} 分钟｜额度 ${state.quota ?? '?'}`;
  }
  if (state.kind === 'wake') {
    return `【窗·自醒】无外界输入｜可做：回顾昨天→架构/鱼眼｜还有 ${state.leftMin} 分钟｜下一交互窗 ${state.nextOpen}`;
  }
  return `【窗·静默】不说话、不发帖｜下一个交互窗 ${state.nextOpen}`;
}
