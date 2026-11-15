import { appendJsonPath } from './json-path.js';

// V8/Chrome cannot materialize a string beyond this limit. Bound the backing
// buffer as well, so a tiny, deeply nested input cannot grow into multi-GB output.
const MAX_OUTPUT_LENGTH = 0x1fffffe8;
const UTF16_ENCODING = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 'utf-16le' : 'utf-16be';

function skipJsonWhitespace(text, i) {
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++;
    else break;
  }
  return i;
}

// 输入必须先通过 JSON.parse；restore=true 时把原生序列化丢失的数字字面量回填
function scanNumberLiterals(text, numberLiterals, restore) {
  const parentDepths = [];
  const containerIsArray = [];
  const arrayIndexes = [];
  const objectRanges = [];
  const activeRanges = [];
  const literalPaths = restore ? null : [];
  const literalValues = restore ? null : [];
  const invalidEnds = restore ? null : [];
  const pathSegments = [];
  const encodedPaths = [''];
  const chunks = restore ? [] : null;
  let depth = 0;
  let i = 0;
  let state = 0; // 0=值，1=对象 key，2=值结束
  let copyFrom = 0;
  let literalCount = 0;

  function setSegment(index, value) {
    pathSegments[index] = value;
    pathSegments.length = index + 1;
    encodedPaths.length = Math.min(encodedPaths.length, index + 1);
  }

  function currentPath() {
    const length = pathSegments.length;
    for (let n = encodedPaths.length; n <= length; n++) {
      encodedPaths[n] = appendJsonPath(encodedPaths[n - 1], pathSegments[n - 1]);
    }
    return encodedPaths[length];
  }

  while (true) {
    if (state === 2) {
      if (depth === 0) break;
      i = skipJsonWhitespace(text, i);
      const parentDepth = parentDepths[depth - 1];
      if (text.charCodeAt(i) === 44) {
        i++;
        if (containerIsArray[depth - 1]) {
          setSegment(parentDepth, ++arrayIndexes[depth - 1]);
          state = 0;
        } else {
          state = 1;
        }
      } else {
        i++;
        if (!restore && !containerIsArray[depth - 1]) activeRanges[depth - 1].end = literalCount;
        depth--;
        pathSegments.length = parentDepth;
        encodedPaths.length = Math.min(encodedPaths.length, parentDepth + 1);
      }
      continue;
    }

    i = skipJsonWhitespace(text, i);
    if (state === 1) {
      const keyStart = i;
      let escaped = false;
      i++;
      while (i < text.length) {
        const c = text.charCodeAt(i);
        if (c === 34) break;
        if (c === 92) {
          escaped = true;
          i += 2;
        } else {
          i++;
        }
      }
      let key = text.slice(keyStart + 1, i);
      if (escaped) key = JSON.parse(text.slice(keyStart, i + 1));
      i = skipJsonWhitespace(text, i + 1) + 1;
      const parentDepth = parentDepths[depth - 1];
      setSegment(parentDepth, key);
      if (!restore) {
        const frame = depth - 1;
        const ranges = objectRanges[frame];
        if (activeRanges[frame]) activeRanges[frame].end = literalCount;
        const previous = ranges.get(key);
        if (previous) {
          // Values occupy contiguous literal ranges. Superseded ranges are
          // nested or disjoint, so one final sweep can discard them all.
          invalidEnds[previous.start] = Math.max(invalidEnds[previous.start] || 0, previous.end);
        }
        const range = { start: literalCount, end: literalCount };
        ranges.set(key, range);
        activeRanges[frame] = range;
      }
      state = 0;
      continue;
    }

    const c = text.charCodeAt(i);
    if (c === 123) {
      i = skipJsonWhitespace(text, i + 1);
      if (text.charCodeAt(i) === 125) {
        i++;
        state = 2;
      } else {
        parentDepths[depth] = pathSegments.length;
        containerIsArray[depth] = false;
        arrayIndexes[depth] = 0;
        if (!restore) {
          const ranges = objectRanges[depth] || new Map();
          ranges.clear();
          objectRanges[depth] = ranges;
          activeRanges[depth] = null;
        }
        depth++;
        state = 1;
      }
      continue;
    }
    if (c === 91) {
      i = skipJsonWhitespace(text, i + 1);
      if (text.charCodeAt(i) === 93) {
        i++;
        state = 2;
      } else {
        const parentDepth = pathSegments.length;
        parentDepths[depth] = parentDepth;
        containerIsArray[depth] = true;
        arrayIndexes[depth] = 0;
        activeRanges[depth] = null;
        depth++;
        setSegment(parentDepth, 0);
        state = 0;
      }
      continue;
    }
    if (c === 34) {
      i++;
      while (i < text.length) {
        const code = text.charCodeAt(i++);
        if (code === 34) break;
        if (code === 92) i++;
      }
      state = 2;
      continue;
    }
    if (c === 45 || (c >= 48 && c <= 57)) {
      const start = i++;
      let simpleInteger = true;
      while (i < text.length) {
        const code = text.charCodeAt(i);
        if (code === 44 || code === 93 || code === 125 || code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09) break;
        if (!restore && (code === 46 || code === 101 || code === 69)) simpleInteger = false;
        i++;
      }
      const length = i - start;
      if (!restore && simpleInteger && length <= 15 && !(length === 2 && text.charCodeAt(start) === 45)) {
        state = 2;
        continue;
      }
      const raw = text.slice(start, i);
      if (restore) {
        const literal = numberLiterals[currentPath()];
        if (literal !== undefined && literal !== raw) {
          chunks.push(text.slice(copyFrom, start), literal);
          copyFrom = i;
        }
      } else {
        const value = Number(raw);
        if (!Number.isFinite(value) || raw !== String(value)) {
          literalCount++;
          literalPaths.push(currentPath());
          literalValues.push(raw);
        }
      }
      state = 2;
      continue;
    }
    if (c === 110) {
      i += 4;
      if (restore) {
        const literal = numberLiterals[currentPath()];
        if (literal !== undefined) {
          chunks.push(text.slice(copyFrom, i - 4), literal);
          copyFrom = i;
        }
      }
    } else {
      i += c === 116 ? 4 : 5;
    }
    state = 2;
  }

  if (!restore) {
    for (let n = 0; n < literalCount;) {
      if (invalidEnds[n] > n) {
        n = invalidEnds[n];
      } else {
        numberLiterals[literalPaths[n]] = literalValues[n];
        n++;
      }
    }
    return numberLiterals;
  }
  if (copyFrom === 0) return text;
  chunks.push(text.slice(copyFrom));
  return chunks.join('');
}

/*
 * 原生 JSON.parse 负责完整的语法和对象语义；扫描仅记录原生序列化会改变的数字。
 * 稀疏字面量表既保留尾零/指数/精度，也避免为普通整数重复占用内存。
 */
export function parseJsonPreservingNumberLiterals(text) {
  const data = JSON.parse(text);
  const numberLiterals = collectNumberLiterals(text);
  return { data, numberLiterals };
}

// 仅用于已经通过 JSON.parse 的原文；供 Worker 缓存补充树视图的数字显示。
export function collectNumberLiterals(text) {
  return scanNumberLiterals(text, Object.create(null), false);
}

function restoreNumberLiterals(text, numberLiterals) {
  if (!numberLiterals) return text;
  for (const path in numberLiterals) return scanNumberLiterals(text, numberLiterals, true);
  return text;
}

// Only parsed JSON reaches this fallback: no cycles, accessors or toJSON hooks.
// Keep native key ordering/string escaping without recursing through containers.
function stringifyJsonIterative(value, indentUnit) {
  const frames = [];
  const lineIndents = ['\n'];
  const newline = (depth) => {
    if (indentUnit === null) return '';
    return lineIndents[depth] ?? (lineIndents[depth] = '\n' + indentUnit.repeat(depth));
  };
  let output = '';
  while (true) {
    if (value !== null && typeof value === 'object') {
      const isArray = Array.isArray(value);
      const keys = isArray ? null : Object.keys(value);
      const length = isArray ? value.length : keys.length;
      output += isArray ? '[' : '{';
      if (length) {
        frames.push({ value, keys, length, index: 0 });
        output += newline(frames.length);
        if (keys) output += JSON.stringify(keys[0]) + (indentUnit === null ? ':' : ': ');
        value = value[keys ? keys[0] : 0];
        continue;
      }
      output += isArray ? ']' : '}';
    } else {
      output += JSON.stringify(value);
    }

    while (frames.length) {
      const frame = frames[frames.length - 1];
      if (++frame.index < frame.length) {
        output += ',' + newline(frames.length);
        const key = frame.keys ? frame.keys[frame.index] : frame.index;
        if (frame.keys) output += JSON.stringify(key) + (indentUnit === null ? ':' : ': ');
        value = frame.value[key];
        break;
      }
      frames.pop();
      output += newline(frames.length) + (frame.keys ? '}' : ']');
    }
    if (!frames.length) return output;
  }
}

function stringifyJson(value, numberLiterals, indentUnit) {
  let output;
  try {
    output = indentUnit === null ? JSON.stringify(value) : JSON.stringify(value, null, indentUnit);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    output = stringifyJsonIterative(value, indentUnit);
  }
  return restoreNumberLiterals(output, numberLiterals);
}

function normalizeJsonIndent(indent) {
  if (indent === 'tab') return '\t';
  const value = Number(indent) || 2;
  if (value <= 0) return null;
  return ' '.repeat(Math.min(10, Math.floor(value)));
}

// 输入已由 JSON.parse 验证。直接复制 token，避免创建每个 token 的切片/连接树。
// 需要原生 key 排序、去重或字符串规范化时整体回退，不返回部分字面量表。
function formatJsonTextDirect(text, indentUnit, collectLiterals) {
  const wide = /[^\x00-\x7f]/.test(text);
  const BufferType = wide ? Uint16Array : Uint8Array;
  let output = new BufferType(Math.min(MAX_OUTPUT_LENGTH, Math.max(64, text.length * (indentUnit === null ? 1 : 2))));
  let used = 0;
  const pretty = indentUnit !== null;
  const indentCode = indentUnit === '\t' ? 9 : 32;
  const indentWidth = indentUnit?.length ?? 0;
  const parentIsArray = [];
  const arrayIndexes = [];
  const keyCounts = [];
  const keySets = [];
  // Sixteen pairs per nesting level; reuse the same storage for sibling objects.
  let keyRanges = new Int32Array(32 * 16);
  const numberLiterals = collectLiterals ? Object.create(null) : null;
  const pathSegments = collectLiterals ? [] : null;
  const pathKeyStarts = collectLiterals ? [] : null;
  const pathKeyEnds = collectLiterals ? [] : null;
  const pathKeyEscapes = collectLiterals ? [] : null;
  const encodedPaths = collectLiterals ? [''] : null;
  let pathLength = 0;
  let encodedLength = 1;
  let depth = 0;
  let i = 0;
  let state = 0; // 0=值，1=对象 key，2=值结束

  function reserve(count) {
    const needed = used + count;
    if (needed > MAX_OUTPUT_LENGTH) throw new RangeError('Formatted JSON exceeds the maximum string length');
    if (needed <= output.length) return;
    const grown = new BufferType(Math.min(MAX_OUTPUT_LENGTH, Math.max(needed, Math.ceil(output.length * 1.5))));
    grown.set(output.subarray(0, used));
    output = grown;
  }

  function copy(start, end) {
    reserve(end - start);
    for (let n = start; n < end; n++) output[used++] = text.charCodeAt(n);
  }

  function newline(level) {
    const count = level * indentWidth;
    reserve(count + 1);
    output[used++] = 10;
    const end = used + count;
    while (used < end) output[used++] = indentCode;
  }

  function setSegment(index, value) {
    pathSegments[index] = value;
    pathLength = index + 1;
    encodedLength = Math.min(encodedLength, index + 1);
  }

  function currentPath() {
    for (let n = encodedLength; n <= pathLength; n++) {
      const frame = n - 1;
      if (pathSegments[frame] === null) {
        pathSegments[frame] = pathKeyEscapes[frame]
          ? JSON.parse(text.slice(pathKeyStarts[frame], pathKeyEnds[frame]))
          : text.slice(pathKeyStarts[frame] + 1, pathKeyEnds[frame] - 1);
      }
      encodedPaths[n] = appendJsonPath(encodedPaths[n - 1], pathSegments[frame]);
    }
    encodedLength = pathLength + 1;
    return encodedPaths[pathLength];
  }

  while (true) {
    if (state === 2) {
      if (depth === 0) break;
      i = skipJsonWhitespace(text, i);
      if (text.charCodeAt(i) === 44) {
        reserve(1);
        output[used++] = 44;
        i++;
        if (pretty) newline(depth);
        if (parentIsArray[depth - 1]) {
          if (collectLiterals) setSegment(depth - 1, ++arrayIndexes[depth - 1]);
          state = 0;
        } else {
          state = 1;
        }
      } else {
        const close = text.charCodeAt(i++);
        depth--;
        if (pretty) newline(depth);
        reserve(1);
        output[used++] = close;
        if (collectLiterals) {
          pathLength = depth;
          encodedLength = Math.min(encodedLength, depth + 1);
        }
      }
      continue;
    }

    i = skipJsonWhitespace(text, i);
    if (state === 1) {
      const start = i++;
      let escaped = false;
      while (i < text.length) {
        const c = text.charCodeAt(i);
        if (c === 34) break;
        if (c === 92) {
          const escapedCode = text.charCodeAt(i + 1);
          if (escapedCode === 117 || escapedCode === 47) return null;
          escaped = true;
          i += 2;
        } else {
          if (c >= 0xd800 && c <= 0xdfff) return null;
          i++;
        }
      }
      i++;
      const first = text.charCodeAt(start + 1);
      if (first >= 48 && first <= 57) return null;
      const frame = depth - 1;
      const base = frame * 32;
      const count = keyCounts[frame];
      let seenSet = keySets[frame];
      if (count < 16) {
        for (let n = 0; n < count; n++) {
          const previousStart = keyRanges[base + n * 2];
          const previousEnd = keyRanges[base + n * 2 + 1];
          if (previousEnd - previousStart !== i - start) continue;
          let offset = 1;
          while (offset < i - start && text.charCodeAt(previousStart + offset) === text.charCodeAt(start + offset)) offset++;
          if (offset === i - start) return null;
        }
        keyRanges[base + count * 2] = start;
        keyRanges[base + count * 2 + 1] = i;
        keyCounts[frame]++;
      } else {
        if (!seenSet) {
          seenSet = new Set();
          for (let n = 0; n < 16; n++) seenSet.add(text.slice(keyRanges[base + n * 2], keyRanges[base + n * 2 + 1]));
          keySets[frame] = seenSet;
        }
        const key = text.slice(start, i);
        if (seenSet.has(key)) return null;
        seenSet.add(key);
      }
      if (collectLiterals) {
        setSegment(frame, null);
        pathKeyStarts[frame] = start;
        pathKeyEnds[frame] = i;
        pathKeyEscapes[frame] = escaped;
      }
      copy(start, i);
      reserve(pretty ? 2 : 1);
      output[used++] = 58;
      if (pretty) output[used++] = 32;
      i = skipJsonWhitespace(text, i) + 1;
      state = 0;
      continue;
    }

    const c = text.charCodeAt(i);
    if (c === 123 || c === 91) {
      const isArray = c === 91;
      const close = isArray ? 93 : 125;
      const end = skipJsonWhitespace(text, i + 1);
      if (text.charCodeAt(end) === close) {
        reserve(2);
        output[used++] = c;
        output[used++] = close;
        i = end + 1;
        state = 2;
        continue;
      }
      parentIsArray[depth] = isArray;
      if (isArray) {
        if (collectLiterals) {
          arrayIndexes[depth] = 0;
          setSegment(depth, 0);
        }
      } else {
        keyCounts[depth] = 0;
        keySets[depth] = null;
        if ((depth + 1) * 32 > keyRanges.length) {
          const grown = new Int32Array(Math.max((depth + 1) * 32, keyRanges.length * 2));
          grown.set(keyRanges);
          keyRanges = grown;
        }
      }
      depth++;
      reserve(1);
      output[used++] = c;
      if (pretty) newline(depth);
      i++;
      state = isArray ? 0 : 1;
      continue;
    }
    if (c === 34) {
      const start = i++;
      while (i < text.length) {
        const code = text.charCodeAt(i++);
        if (code === 34) break;
        if (code === 92) {
          const escapedCode = text.charCodeAt(i++);
          if (escapedCode === 117 || escapedCode === 47) return null;
        } else if (code >= 0xd800 && code <= 0xdfff) {
          return null;
        }
      }
      copy(start, i);
      state = 2;
      continue;
    }
    const start = i;
    let simpleInteger = true;
    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (code === 44 || code === 93 || code === 125 || code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09) break;
      if (code === 46 || code === 101 || code === 69) simpleInteger = false;
      i++;
    }
    if (collectLiterals && (c === 45 || (c >= 48 && c <= 57))) {
      const length = i - start;
      if (!simpleInteger || length > 15 || (length === 2 && c === 45)) {
        const raw = text.slice(start, i);
        const value = Number(raw);
        if (!Number.isFinite(value) || raw !== String(value)) numberLiterals[currentPath()] = raw;
      }
    }
    copy(start, i);
    state = 2;
  }
  return { text: new TextDecoder(wide ? UTF16_ENCODING : 'utf-8').decode(output.subarray(0, used)), numberLiterals };
}

/**
 * 解析并排版 JSON，保留原文数字字面量及 JSON.parse 的 key 排序/去重语义。
 * indent=null 表示压缩；仅树形显示需要额外返回数字字面量表。
 * 核心根据输入选择序列化方式，缓存/传输选项不影响算法；无效输入抛出 SyntaxError。
 */
export function formatJson(text, { indent = '2', includeNumberLiterals = false, parsed = null } = {}) {
  // parsed 只由持有同一原文解析结果的 Worker 会话传入，避免切换视图重复解析。
  const data = parsed ? parsed.data : JSON.parse(text);
  const indentUnit = indent === null ? null : normalizeJsonIndent(indent);
  let numberLiterals = parsed?.numberLiterals ?? null;
  const direct = formatJsonTextDirect(text, indentUnit, includeNumberLiterals && numberLiterals === null);
  if (direct) {
    numberLiterals ??= direct.numberLiterals;
    return { text: direct.text, data, numberLiterals };
  }
  numberLiterals ??= collectNumberLiterals(text);
  return { text: stringifyJson(data, numberLiterals, indentUnit), data, numberLiterals };
}
