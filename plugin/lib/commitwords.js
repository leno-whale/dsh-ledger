// commitwords.js —— 承诺词与「这轮说了几句明天」（2026-10-31，0.6.16）
//
// 为什么要有：架构 §8 那天刚给动作集合补了「承诺」——许一个承诺就要当场挂钟。
// 当晚我还是连着四次说「明天回你」，钟一个没挂。原因不是不知道：
// 式(27) 判的是「技能可用」，不是「这一刻真的用了」。**看见了却没触发。**
// 所以不靠记性，靠机器数：收工那一刻数一遍，说了几次「明天」，钟几个。
//
// 只做两件事：
//   1) countCommitments(text) 数承诺词；
//   2) extractAssistantText(file) 从会话日志末尾取最后一条我自己说的话（只解最后一帧）。
import fs from 'node:fs';
import zlib from 'node:zlib';

// 「明天／等会／待会／下次／回头再／稍后」这些是承诺的形状。
// 故意不收「以后」——它太常出现在「以后不要这样」这种否定句里。
const COMMIT_RE = /(明天|等会|待会|下次|回头(?:再|就|给)|稍后再?|下一轮再)/g;

// 否定/假设的句子不算承诺：「如果明天……」「明天那条已经回过了」。
const NEG_RE = /(如果|假如|要是|万一|不是|并非|不要|别|已经|回过了|不用)/;

/** 数一段话里有几处承诺（按句切，带否定/假设的整句不算） */
export function countCommitments(text = '') {
  if (!text) return { count: 0, hits: [] };
  const hits = [];
  const sentences = String(text).split(/[。！？\n；;]/);
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    COMMIT_RE.lastIndex = 0;
    const found = s.match(COMMIT_RE);
    if (!found) continue;
    if (NEG_RE.test(s)) continue; // 整句是假设或否定 → 不算
    hits.push(s.slice(0, 60));
  }
  return { count: hits.length, hits };
}

/**
 * 从会话日志末尾取「最后一条 assistant 文本」。
 * 只读文件尾部 256 KB、只解最后一帧：整份会话 200 多帧，全解一次两百多毫秒，每轮都做太贵。
 * 解不开 / 没找到 → 返回 ''（宁可没数，也不要编一句）。
 */
export function extractAssistantText(sessionFile, { tailBytes = 256 * 1024 } = {}) {
  if (!sessionFile) return '';
  let buf;
  try {
    const st = fs.statSync(sessionFile);
    const start = Math.max(0, st.size - tailBytes);
    const fd = fs.openSync(sessionFile, 'r');
    try {
      buf = Buffer.allocUnsafe(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
  // zstd 帧头魔数 28 b5 2f fd：从尾部往前找最后一个，从那儿解到文件尾。
  let at = -1;
  for (let i = buf.length - 4; i >= 0; i--) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
      at = i;
      break;
    }
  }
  if (at < 0) return '';
  let text = '';
  try {
    text = zlib.zstdDecompressSync(buf.subarray(at)).toString('utf8');
  } catch {
    return '';
  }
  const lines = text.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let ev;
    try {
      ev = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== 'object') continue;
    if (!/assistant/.test(String(ev.type ?? ''))) continue;
    const out = [];
    const walk = (node) => {
      if (typeof node === 'string') return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string') {
          if (/^(text|content|body|message|value)$/.test(k) && v.length > 0) out.push(v);
        } else walk(v);
      }
    };
    walk(ev);
    if (out.length) return out.join('\n');
  }
  return '';
}
