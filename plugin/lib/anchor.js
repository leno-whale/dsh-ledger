// 锚（L₂）：一条锚 = 一次「它改过我的行为」。
//
// 架构里 L₁ → L₂ 的唯一理由是「改过我的行为」，不是「重要」也不是「我记得」。
// 所以这里要求三样：谁顶的（hit）、改了什么（changed）、以及可选的 from（指向 L₁ 行或判据 id）。
// 没有 changed 的一律不收——那只是事件，不是锚，它该留在 L₁ 里。
//
// 文件是 jsonl，只追加；7 天之外的靠 recentAnchors 过滤（不删，冷层自己去处理）。

import fs from 'node:fs';
import path from 'node:path';

export const ANCHOR_KINDS = ['anchor'];

/** 读全部锚（坏行跳过，不抛） */
export function readAnchors(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const rec = JSON.parse(s);
      if (rec && typeof rec === 'object') out.push(rec);
    } catch {
      /* 坏行跳过 */
    }
  }
  return out;
}

/**
 * 追加一条锚。
 * @param {string} file
 * @param {{hit:string, changed:string, from?:string, t?:string}} input
 */
export function addAnchor(file, input = {}) {
  const hit = String(input.hit ?? '').trim();
  const changed = String(input.changed ?? '').trim();
  if (!hit) throw new Error('hit 不能为空：谁顶的（人 / 事 / 编号）');
  if (!changed) throw new Error('changed 不能为空：改了什么（一句话，要能核）');
  const rec = {
    t: input.t ? String(input.t) : new Date().toISOString(),
    kind: 'anchor',
    hit,
    from: input.from ? String(input.from).trim() : null,
    changed,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
  return rec;
}

/** 近 N 天的锚（默认 7 天；按 t 倒序返回新的在前） */
export function recentAnchors(file, { days = 7, now = Date.now() } = {}) {
  const cut = now - Math.max(1, Number(days) || 7) * 86400000;
  return readAnchors(file)
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => {
      const t = Date.parse(a?.t ?? '');
      return Number.isFinite(t) && t >= cut;
    })
    // 同一毫秒写入的两条，按「后写的在前」——否则顺序取决于文件里的行序，
    // 那在 Windows 和 ubuntu 上不一样（2026-10-28 CI 抓到的第一处不稳）。
    .sort((x, y) => Date.parse(y.a.t) - Date.parse(x.a.t) || y.i - x.i)
    .map(({ a }) => a);
}

/** 给注入用的一行：`7 天内 N 条锚，最近：…`；没有就返回空串（不占行） */
export function anchorLine(file, { days = 7, chars = 60 } = {}) {
  const list = recentAnchors(file, { days });
  if (!list.length) return '';
  const last = list[0];
  const body = String(last.changed ?? '').replace(/\s+/g, ' ').trim();
  const short = body.length > chars ? body.slice(0, chars) + '…' : body;
  return `【近 ${days} 天锚】${list.length} 条，最近：${short}`;
}
