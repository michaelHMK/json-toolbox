import { formatJson } from './json.js';

// 限制编辑距离和回溯内存；长文档的少量修改仍可保留公共行。
const TEXT_DIFF_MAX_DISTANCE = 3000;
const TEXT_DIFF_MAX_TRACE_BYTES = 20 * 1024 * 1024;

// Keep only offsets and 32-bit fingerprints, not a string and an array entry
// for every line. Hash matches are always checked against the source text:
// collisions must never turn a changed line into an unchanged one.
// This API compares LF-delimited formatted text, preserving any literal CR.
function indexLines(text) {
  let count = 1;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++;
  const starts = new Uint32Array(count + 1);
  const hashes = new Int32Array(count);
  let start = 0;
  for (let line = 0; line < count; line++) {
    starts[line] = start;
    const end = line + 1 === count ? text.length : text.indexOf('\n', start);
    let hash = 2166136261;
    for (let at = start; at < end; at++) hash = Math.imul(hash ^ text.charCodeAt(at), 16777619);
    hashes[line] = hash;
    start = end + 1;
  }
  starts[count] = text.length + 1;
  return { text, starts, hashes, count };
}

function sameLine(a, ai, b, bi) {
  if (a.hashes[ai] !== b.hashes[bi]) return false;
  const startA = a.starts[ai];
  const startB = b.starts[bi];
  const length = a.starts[ai + 1] - startA - 1;
  if (length !== b.starts[bi + 1] - startB - 1) return false;
  for (let offset = 0; offset < length; offset++) {
    if (a.text.charCodeAt(startA + offset) !== b.text.charCodeAt(startB + offset)) return false;
  }
  return true;
}

// Myers O(ND) 行级 diff，返回 run 序列：{ type: 'same'|'del'|'add', aStart/bStart, count }
function myersOps(a, b, start, N, M) {
  if (!N) return M ? [{ type: 'add', bStart: 0, count: M }] : [];
  if (!M) return [{ type: 'del', aStart: 0, count: N }];
  if (Math.abs(N - M) > TEXT_DIFF_MAX_DISTANCE) return null;

  // 第 d 轮只有 d+1 条有效对角线；无需为每轮复制长度 2*(N+M) 的前沿。
  const trace = [];
  let previous = new Int32Array(1);
  let traceBytes = previous.byteLength;
  let D = -1;
  search: for (let d = 0; d <= Math.min(N + M, TEXT_DIFF_MAX_DISTANCE); d++) {
    const bytes = (d + 1) * Int32Array.BYTES_PER_ELEMENT;
    if (traceBytes + bytes > TEXT_DIFF_MAX_TRACE_BYTES) return null;
    const current = new Int32Array(d + 1);
    traceBytes += bytes;
    for (let i = 0; i <= d; i++) {
      const k = 2 * i - d;
      let x = (i === 0 || (i !== d && previous[i - 1] < previous[i]))
        ? previous[i] : previous[i - 1] + 1;
      let y = x - k;
      while (x < N && y < M && sameLine(a, x + start, b, y + start)) { x++; y++; }
      current[i] = x;
      if (x >= N && y >= M) { D = d; break search; }
    }
    trace.push(current);
    previous = current;
  }
  if (D === -1) return null;

  // 回溯时直接合并区间，避免为每一行建立临时操作对象。
  const ops = [];
  function appendRun(type, aStart, bStart, count) {
    const last = ops[ops.length - 1];
    if (last && last.type === type) {
      last.count += count;
      if (aStart !== undefined) last.aStart = aStart;
      if (bStart !== undefined) last.bStart = bStart;
    } else {
      const op = { type, count };
      if (aStart !== undefined) op.aStart = aStart;
      if (bStart !== undefined) op.bStart = bStart;
      ops.push(op);
    }
  }
  let x = N;
  let y = M;
  for (let d = D; d >= 1; d--) {
    const previous = trace[d - 1];
    const k = x - y;
    const i = (k + d) / 2;
    const down = i === 0 || (i !== d && previous[i - 1] < previous[i]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = previous[down ? i : i - 1];
    const prevY = prevX - prevK;
    const same = Math.min(x - prevX, y - prevY);
    if (same > 0) {
      x -= same;
      y -= same;
      appendRun('same', x, y, same);
    }
    if (x === prevX) appendRun('add', undefined, --y, 1);
    else appendRun('del', --x, undefined, 1);
  }
  const same = Math.min(x, y);
  if (same > 0) appendRun('same', x - same, y - same, same);
  return ops.reverse();
}

/*
 * 文本对比：两边用相同缩进格式化后做行级 diff。
 * 先削掉头尾公共行，再跑带编辑距离和内存预算的 Myers；
 * 超出预算才退化为整块 del+add（blocky=true）。
 * ops 只存行区间，行内容由主线程从 aText/bText 里取。
 */
export function makeTextDiff(text, text2, indent) {
  const aText = formatJson(text, { indent }).text;
  const bText = text === text2 ? aText : formatJson(text2, { indent }).text;
  return diffFormattedText(aText, bText);
}

// Worker 可直接比较会话里已格式化的文本，不重复解析和排版。
export function diffFormattedText(aText, bText) {
  if (aText === bText) {
    let count = 1;
    let newline = -1;
    while ((newline = aText.indexOf('\n', newline + 1)) !== -1) count++;
    return {
      ops: [{ type: 'same', aStart: 0, bStart: 0, count }],
      aText, bText, blocky: false, totalLines: [count, count],
    };
  }
  const a = indexLines(aText);
  const b = indexLines(bText);

  let start = 0;
  while (start < a.count && start < b.count && sameLine(a, start, b, start)) start++;
  let endA = a.count - 1;
  let endB = b.count - 1;
  while (endA >= start && endB >= start && sameLine(a, endA, b, endB)) { endA--; endB--; }

  const countA = endA + 1 - start;
  const countB = endB + 1 - start;
  const ops = [];
  let blocky = false;

  if (start > 0) ops.push({ type: 'same', aStart: 0, bStart: 0, count: start });
  const middleOps = myersOps(a, b, start, countA, countB);
  if (middleOps === null) {
    blocky = true;
    if (countA) ops.push({ type: 'del', aStart: start, count: countA });
    if (countB) ops.push({ type: 'add', bStart: start, count: countB });
  } else {
    for (const op of middleOps) {
      const shifted = { type: op.type, count: op.count };
      if (op.aStart !== undefined) shifted.aStart = op.aStart + start;
      if (op.bStart !== undefined) shifted.bStart = op.bStart + start;
      ops.push(shifted);
    }
  }
  const suffix = a.count - 1 - endA;
  if (suffix > 0) ops.push({ type: 'same', aStart: endA + 1, bStart: endB + 1, count: suffix });

  return { ops, aText, bText, blocky, totalLines: [a.count, b.count] };
}
