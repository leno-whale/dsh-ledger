/**
 * L1 时间戳：给同一分钟的每一行加序号。
 *
 * 2026-10-29（架构 I_time）：架构里 τ(x) 是「第几个采样点」，不是时间字符串。
 * 2026-10-29（架构 T2）：同一毫秒/同一分钟落两行时，光有时间分不出先后——
 *   而「先改后备份」和「先备份后改」是两件事，分不出先后就判不了因果。
 * 所以每行的时间戳后面挂一个 `#n`，n = 这个文件里同前缀已出现的行数 + 1。
 *
 * 计数只扫当前文件（L1 一天一个文件），不扫别的日子——跨文件比 n 没有意义。
 */
import fs from 'node:fs';

/** 这个文件里已经有多少行以 stamp 开头（含已经带了 #n 的）。 */
export function seqOf(file, stamp) {
  try {
    if (!fs.existsSync(file)) return 0;
    const body = fs.readFileSync(file, 'utf8');
    if (!body) return 0;
    let n = 0;
    for (const line of body.split('\n')) {
      if (line.startsWith(stamp)) n += 1;
    }
    return n;
  } catch {
    // 读不到就当第 1 行——序号宁可重复，也不许因为读失败而不写。
    return 0;
  }
}

/** 返回带序号的戳：`2026-10-29T00:49#1`。 */
export function stampWithSeq(file, stamp) {
  return `${stamp}#${seqOf(file, stamp) + 1}`;
}
