// A transferable/cloneable index has no source text or bound methods. Workers
// build this once; the UI attaches a reader without scanning the document.
export function createTextLineIndex(text) {
  const hasCR = text.includes('\r');
  const visitBreaks = (visit) => {
    if (hasCR) {
      const breaks = /\r\n|\r|\n/g;
      let match;
      while ((match = breaks.exec(text))) visit(match.index, breaks.lastIndex);
    } else {
      for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) visit(at, at + 1);
    }
  };
  let count = 1;
  visitBreaks(() => count++);
  const starts = new Uint32Array(count + 1);
  let line = 1;
  let previous = 0;
  let maxLineLength = 0;
  visitBreaks((at, next) => {
    maxLineLength = Math.max(maxLineLength, at - previous);
    starts[line++] = next;
    previous = next;
  });
  maxLineLength = Math.max(maxLineLength, text.length - previous);
  starts[count] = text.length;
  // Long minified lines can spend tens of milliseconds just checking their
  // character width. Carry the safe fast-path flag with the Worker index.
  const ascii = maxLineLength > 8000 && !(count === 1
    ? /[^\x20-\x7e]/.test(text) : /[^\x20-\x7e\r\n]/.test(text));
  return { starts, count, maxLineLength, ascii };
}

// Store offsets into the original string, never an array of every line's text.
// A supplied index must describe this exact text, including its CR/LF policy.
export function createTextLines(text, index) {
  const { starts, count, maxLineLength, ascii } = index ?? createTextLineIndex(text);
  return {
    text, starts, count, maxLineLength,
    bounds(index) {
      if (!Number.isInteger(index) || index < 0 || index >= count) throw new RangeError('Line out of bounds');
      const start = starts[index];
      let end = starts[index + 1];
      if (index + 1 < count) {
        if (text.charCodeAt(end - 1) === 10) end--;
        if (text.charCodeAt(end - 1) === 13) end--;
      }
      return { text, start, end, prefix: '', className: '', ascii };
    },
  };
}

export function createPlainTextRows(text, index) {
  const lines = createTextLines(text, index);
  return {
    count: lines.count,
    maxLineLength: lines.maxLineLength,
    sourceText: text,
    getRow: (index) => lines.bounds(index),
    copyText: () => text,
  };
}

// A segment describes many displayed rows. Even million-line add/delete blocks
// need one segment each; individual rows are materialized only for the viewport.
export function createDiffTextRows(result, { gapText, blockyText } = {}) {
  const left = createTextLines(result.aText, result.aLineIndex);
  const right = createTextLines(result.bText, result.bLineIndex);
  const segments = [];
  let count = 0;
  const append = (length, source, start, className, prefix, note) => {
    if (!length) return;
    segments.push({ from: count, count: length, source, start, className, prefix, note });
    count += length;
  };
  for (const op of result.ops) {
    if (op.type === 'same') {
      if (op.count > 8) {
        append(3, left, op.aStart, 'same', '  ');
        append(1, null, 0, 'gap', '', gapText ? gapText(op.count - 6) : `… ${op.count - 6} …`);
        append(3, left, op.aStart + op.count - 3, 'same', '  ');
      } else append(op.count, left, op.aStart, 'same', '  ');
    } else if (op.type === 'del') append(op.count, left, op.aStart, 'del', '- ');
    else append(op.count, right, op.bStart, 'add', '+ ');
  }
  if (result.blocky) append(1, null, 0, 'gap', '', blockyText || 'Large changes are shown as blocks.');
  const getRow = (index) => {
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new RangeError('Row out of bounds');
    let low = 0;
    let high = segments.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >>> 1;
      if (segments[middle].from <= index) low = middle;
      else high = middle - 1;
    }
    const segment = segments[low];
    const row = segment.source ? segment.source.bounds(segment.start + index - segment.from)
      : { text: segment.note, start: 0, end: segment.note.length };
    return { ...row, prefix: segment.prefix, className: segment.className };
  };
  return {
    count,
    segmentCount: segments.length,
    maxLineLength: Math.max(left.maxLineLength, right.maxLineLength) + 2,
    getRow,
    copyText() {
      const rows = [];
      for (let i = 0; i < count; i++) {
        const row = getRow(i);
        rows.push(row.prefix + row.text.slice(row.start, row.end));
      }
      return rows.join('\n');
    },
  };
}

export function safeTextWindow(text, start, end) {
  start = Math.max(0, Math.min(text.length, start));
  end = Math.max(start, Math.min(text.length, end));
  // A horizontal window must never display half of a UTF-16 surrogate pair.
  const first = text.charCodeAt(start);
  if (start > 0 && first >= 0xdc00 && first <= 0xdfff) start--;
  const last = text.charCodeAt(end - 1);
  if (end < text.length && last >= 0xd800 && last <= 0xdbff) end++;
  return { start, end };
}
