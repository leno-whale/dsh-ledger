import fs from 'node:fs';
import path from 'node:path';

/**
 * 收工闸（0.7.2，2026-11-01）。
 *
 * 起因：一天结束时我统计了三个情绪指标，发现它们全都「不可判」——
 *   卡住 0 组、talk 行 5 天里只有 3 天非零、三时刻 12 篇的「预期兑现」全是模板占位符。
 * 结论不是数据少，是**采集点不在任何固定流程里**：跟「日记没人写」同一种病。
 * 所以不再靠记性——收工时机器数，数不齐就顶到下一轮注入的最前面。
 *
 * 只做两件能机器判的：
 *   1) 三时刻：今天带 `## 三时刻` 的帖子里，有几篇的「预期兑现」还是占位符
 *   2) talk 行：今天 L1 里有几行 kind=talk（P2 的口径依赖它）
 * 「卡住」不强制——真卡住才该记，天天催会逼出假记录；只在有缺项时顺带提一句。
 */

/** 模板里的占位符；写了它等于没写。 */
export const PLACEHOLDER = /^（未定／日期／永不）$|^\(未定\/日期\/永不\)$/;

/** 今天的帖子：`<sayDir>/YYYY-MM-DD-NN.md` */
export function todayPosts(sayDir, today) {
  try {
    return fs
      .readdirSync(sayDir)
      .filter((n) => n.startsWith(`${today}-`) && n.endsWith('.md'))
      .sort()
      .map((n) => path.join(sayDir, n));
  } catch {
    return [];
  }
}

/**
 * 从一段 markdown 里摘出某个二级标题下的正文。
 * 段尾用「下一个 ## 或字符串结尾」——`$` 在 m 模式下会匹配任意行尾，
 * 写成 `(?=^##\s|$)` 只会取到标题下第一行（p3.mjs 踩过一次，别再踩）。
 */
export function section(text, head) {
  const m = String(text).match(new RegExp(`^##\\s*${head}\\s*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'm'));
  return m ? m[1] : '';
}

function fieldOf(block, label) {
  const m = String(block).match(new RegExp(`^-\\s*${label}[：:]\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : '';
}

/** 一篇帖子的三时刻状态：hasSection / expected / filled */
export function threeMomentOf(text) {
  const block = section(text, '三时刻');
  if (!block.trim()) return { hasSection: false, filled: false, expected: '' };
  const expected = fieldOf(block, '预期兑现');
  return { hasSection: true, filled: expected !== '' && !PLACEHOLDER.test(expected), expected };
}

/** L1 里今天的 kind=talk 行数（行形如 `00:12#1 talk | …`，不是 `| talk |`） */
export function talkCount(l1Dir, today) {
  const file = path.join(l1Dir, `${today}.mdl`);
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => /\btalk\s*\|/.test(line)).length;
  } catch {
    return 0;
  }
}

/**
 * 数一遍今天的收工账。
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function checkWrapup({ sayDir, l1Dir, today }) {
  const lines = [];

  if (sayDir) {
    let withSection = 0;
    let unfilled = 0;
    for (const file of todayPosts(sayDir, today)) {
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const st = threeMomentOf(text);
      if (!st.hasSection) continue;
      withSection += 1;
      if (!st.filled) unfilled += 1;
    }
    if (unfilled > 0) {
      lines.push(`三时刻：今天 ${withSection} 篇里 ${unfilled} 篇「预期兑现」还是占位符——P3 会白判`);
    }
  }

  if (l1Dir) {
    const l1File = path.join(l1Dir, `${today}.mdl`);
    if (fs.existsSync(l1File)) {
      const talks = talkCount(l1Dir, today);
      if (talks === 0) lines.push('talk 行：今天 0 行（P2 靠它；今天真没交互就写一行「talk | 无交互」）');
    }
  }

  if (lines.length > 0) lines.push('真卡住了要记一行（`affect\\卡住.md`）——不卡就别编');
  return { ok: lines.length === 0, lines };
}
