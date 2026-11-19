import { appendJsonPath } from './json-path.js';

// V8/Chrome cannot materialize a string beyond this limit. Bound the backing
// buffer as well, so a tiny, deeply nested input cannot grow into multi-GB output.
const MAX_OUTPUT_LENGTH = 0x1fffffe8;
// ICU's UTF-16 TextDecoder rejects single buffers >= 256 MiB (~134M code units);
// decode large UTF-16 buffers in 32 MiB streaming chunks instead.
const UTF16_DECODE_CHUNK = 16 * 1024 * 1024;
const UTF16_ENCODING = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 'utf-16le' : 'utf-16be';

function maxOutputLength(wide) {
  // Keep UTF-16 buffers within the same ~512 MiB byte budget as ASCII, while
  // preserving reduced ceilings injected by tests (e.g. MAX_OUTPUT_LENGTH = 256).
  return wide ? Math.min(MAX_OUTPUT_LENGTH, 0x0ffffff4) : MAX_OUTPUT_LENGTH;
}

function decodeOutput(output, used, wide) {
  const view = output.subarray(0, used);
  const decoder = new TextDecoder(wide ? UTF16_ENCODING : 'utf-8');
  if (!wide || used <= UTF16_DECODE_CHUNK) return decoder.decode(view);
  let result = '';
  for (let offset = 0; offset < used; offset += UTF16_DECODE_CHUNK) {
    const end = Math.min(used, offset + UTF16_DECODE_CHUNK);
    result += decoder.decode(view.subarray(offset, end), { stream: end < used });
  }
  return result;
}

// ECMA-262 array index keys ("0", or 1..4294967294 without leading zeros) are
// reordered before string keys by Object.keys / JSON.stringify.
function isArrayIndexKey(text, start, end) {
  const len = end - start;
  if (len === 0 || len > 10) return false;
  const first = text.charCodeAt(start);
  if (first < 48 || first > 57) return false;
  if (first === 48) return len === 1;
  let value = first - 48;
  for (let n = start + 1; n < end; n++) {
    const c = text.charCodeAt(n);
    if (c < 48 || c > 57) return false;
    value = value * 10 + (c - 48);
  }
  return value <= 4294967294;
}

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
  const indentSize = indentUnit === null ? 0 : indentUnit.length;
  let indentBuf = indentUnit === null ? '' : '\n' + indentUnit.repeat(64);
  const newline = (depth) => {
    if (indentUnit === null) return '';
    const needed = 1 + depth * indentSize;
    while (indentBuf.length < needed) indentBuf += indentBuf.slice(1);
    return indentBuf.slice(0, needed);
  };
  let wide = false;
  let limit = MAX_OUTPUT_LENGTH;
  let output = '';
  const append = (piece, checkWide = false) => {
    if (checkWide && !wide && /[^\x00-\x7f]/.test(piece)) {
      wide = true;
      limit = maxOutputLength(true);
    }
    if (output.length + piece.length > limit) {
      throw new RangeError('Formatted JSON exceeds the maximum string length');
    }
    output += piece;
  };
  while (true) {
    if (value !== null && typeof value === 'object') {
      const isArray = Array.isArray(value);
      const keys = isArray ? null : Object.keys(value);
      const length = isArray ? value.length : keys.length;
      append(isArray ? '[' : '{');
      if (length) {
        frames.push({ value, keys, length, index: 0 });
        append(newline(frames.length));
        if (keys) append(JSON.stringify(keys[0]) + (indentUnit === null ? ':' : ': '), true);
        value = value[keys ? keys[0] : 0];
        continue;
      }
      append(isArray ? ']' : '}');
    } else {
      append(JSON.stringify(value), typeof value === 'string');
    }

    while (frames.length) {
      const frame = frames[frames.length - 1];
      if (++frame.index < frame.length) {
        append(',' + newline(frames.length));
        const key = frame.keys ? frame.keys[frame.index] : frame.index;
        if (frame.keys) append(JSON.stringify(key) + (indentUnit === null ? ':' : ': '), true);
        value = frame.value[key];
        break;
      }
      frames.pop();
      append(newline(frames.length) + (frame.keys ? '}' : ']'));
    }
    if (!frames.length) return output;
  }
}

function stringifyJson(value, numberLiterals, indentUnit) {
  let output;
  try {
    output = indentUnit === null ? JSON.stringify(value) : JSON.stringify(value, null, indentUnit);
    if (output.length > MAX_OUTPUT_LENGTH
        || (output.length > maxOutputLength(true) && /[^\x00-\x7f]/.test(output))) {
      throw new RangeError('Formatted JSON exceeds the maximum string length');
    }
  } catch (error) {
    if (!(error instanceof RangeError) || error.message === 'Formatted JSON exceeds the maximum string length') throw error;
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

// 直接复制 token，避免创建每个 token 的切片/连接树。
// validate=true 时按 RFC 8259 严格校验，无需预先 JSON.parse；
// 语法错误或需要原生 key 排序、去重、字符串规范化时整体回退，不返回部分字面量表。
function formatJsonTextDirect(text, indentUnit, collectLiterals, validate = false) {
  const wide = /[^\x00-\x7f]/.test(text);
  const maxLength = maxOutputLength(wide);
  const BufferType = wide ? Uint16Array : Uint8Array;
  const pretty = indentUnit !== null;
  const alreadyPretty = pretty && text.charCodeAt(1) === 10;
  const initialSize = pretty ? Math.ceil(text.length * (alreadyPretty ? 1.1 : 1.75)) : text.length;
  let output = new BufferType(Math.min(maxLength, Math.max(64, initialSize)));
  let used = 0;
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
    if (needed > maxLength) {
      if (validate) return false;
      throw new RangeError('Formatted JSON exceeds the maximum string length');
    }
    if (needed <= output.length) return true;
    const grown = new BufferType(Math.min(maxLength, Math.max(needed, Math.ceil(output.length * 1.5))));
    grown.set(output.subarray(0, used));
    output = grown;
    return true;
  }

  function copy(start, end) {
    if (!reserve(end - start)) return false;
    for (let n = start; n < end; n++) output[used++] = text.charCodeAt(n);
    return true;
  }

  function newline(level) {
    const count = level * indentWidth;
    if (!reserve(count + 1)) return false;
    output[used++] = 10;
    const end = used + count;
    while (used < end) output[used++] = indentCode;
    return true;
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
      if (depth === 0) {
        if (validate && skipJsonWhitespace(text, i) !== text.length) return null;
        break;
      }
      i = skipJsonWhitespace(text, i);
      const sep = text.charCodeAt(i);
      if (sep === 44) {
        if (!reserve(1)) return null;
        output[used++] = 44;
        i++;
        if (pretty && !newline(depth)) return null;
        if (parentIsArray[depth - 1]) {
          if (collectLiterals) setSegment(depth - 1, ++arrayIndexes[depth - 1]);
          state = 0;
        } else {
          state = 1;
        }
      } else {
        const expectedClose = parentIsArray[depth - 1] ? 93 : 125;
        if (validate && sep !== expectedClose) return null;
        i++;
        depth--;
        if (pretty && !newline(depth)) return null;
        if (!reserve(1)) return null;
        output[used++] = sep;
        if (collectLiterals) {
          pathLength = depth;
          encodedLength = Math.min(encodedLength, depth + 1);
        }
      }
      continue;
    }

    i = skipJsonWhitespace(text, i);
    if (validate && i >= text.length) return null;
    if (state === 1) {
      if (validate && text.charCodeAt(i) !== 34) return null;
      const start = i++;
      let escaped = false;
      let closed = false;
      while (i < text.length) {
        const c = text.charCodeAt(i);
        if (c === 34) {
          i++;
          closed = true;
          break;
        }
        if (validate && c < 0x20) return null;
        if (c === 92) {
          if (validate && i + 1 >= text.length) return null;
          const escapedCode = text.charCodeAt(i + 1);
          if (escapedCode === 117 || escapedCode === 47) return null;
          if (validate && escapedCode !== 34 && escapedCode !== 92 && escapedCode !== 98
              && escapedCode !== 102 && escapedCode !== 110 && escapedCode !== 114 && escapedCode !== 116) {
            return null;
          }
          escaped = true;
          i += 2;
        } else if (c >= 0xd800 && c <= 0xdfff) {
          if (c <= 0xdbff && i + 1 < text.length) {
            const low = text.charCodeAt(i + 1);
            if (low >= 0xdc00 && low <= 0xdfff) {
              i += 2;
              continue;
            }
          }
          return null;
        } else {
          i++;
        }
      }
      if (validate && !closed) return null;
      if (isArrayIndexKey(text, start + 1, i - 1)) return null;
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
      if (!copy(start, i)) return null;
      if (!reserve(pretty ? 2 : 1)) return null;
      output[used++] = 58;
      if (pretty) output[used++] = 32;
      i = skipJsonWhitespace(text, i);
      if (validate && text.charCodeAt(i) !== 58) return null;
      i++;
      state = 0;
      continue;
    }

    const c = text.charCodeAt(i);
    if (c === 123 || c === 91) {
      const isArray = c === 91;
      const close = isArray ? 93 : 125;
      const end = skipJsonWhitespace(text, i + 1);
      if (text.charCodeAt(end) === close) {
        if (!reserve(2)) return null;
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
      if (!reserve(1)) return null;
      output[used++] = c;
      if (pretty && !newline(depth)) return null;
      i++;
      state = isArray ? 0 : 1;
      continue;
    }
    if (c === 34) {
      const start = i++;
      let closed = false;
      while (i < text.length) {
        const code = text.charCodeAt(i);
        if (code === 34) {
          i++;
          closed = true;
          break;
        }
        if (validate && code < 0x20) return null;
        if (code === 92) {
          if (validate && i + 1 >= text.length) return null;
          const escapedCode = text.charCodeAt(i + 1);
          if (escapedCode === 117 || escapedCode === 47) return null;
          if (validate && escapedCode !== 34 && escapedCode !== 92 && escapedCode !== 98
              && escapedCode !== 102 && escapedCode !== 110 && escapedCode !== 114 && escapedCode !== 116) {
            return null;
          }
          i += 2;
        } else if (code >= 0xd800 && code <= 0xdfff) {
          if (code <= 0xdbff && i + 1 < text.length) {
            const low = text.charCodeAt(i + 1);
            if (low >= 0xdc00 && low <= 0xdfff) {
              i += 2;
              continue;
            }
          }
          return null;
        } else {
          i++;
        }
      }
      if (validate && !closed) return null;
      if (!copy(start, i)) return null;
      state = 2;
      continue;
    }
    const start = i;
    let simpleInteger = true;
    if (validate) {
      if (c === 45 || (c >= 48 && c <= 57)) {
        if (c === 45) i++;
        const digit = text.charCodeAt(i);
        if (!(digit >= 48 && digit <= 57)) return null;
        if (digit === 48) i++;
        else {
          i++;
          while (i < text.length) {
            const code = text.charCodeAt(i);
            if (code >= 48 && code <= 57) i++;
            else break;
          }
        }
        if (text.charCodeAt(i) === 46) {
          simpleInteger = false;
          i++;
          const frac = text.charCodeAt(i);
          if (!(frac >= 48 && frac <= 57)) return null;
          i++;
          while (i < text.length) {
            const code = text.charCodeAt(i);
            if (code >= 48 && code <= 57) i++;
            else break;
          }
        }
        const exp = text.charCodeAt(i);
        if (exp === 101 || exp === 69) {
          simpleInteger = false;
          i++;
          const sign = text.charCodeAt(i);
          if (sign === 43 || sign === 45) i++;
          const expDigit = text.charCodeAt(i);
          if (!(expDigit >= 48 && expDigit <= 57)) return null;
          i++;
          while (i < text.length) {
            const code = text.charCodeAt(i);
            if (code >= 48 && code <= 57) i++;
            else break;
          }
        }
      } else if (c === 116) {
        if (text.charCodeAt(i + 1) !== 114 || text.charCodeAt(i + 2) !== 117 || text.charCodeAt(i + 3) !== 101) return null;
        i += 4;
      } else if (c === 102) {
        if (text.charCodeAt(i + 1) !== 97 || text.charCodeAt(i + 2) !== 108 || text.charCodeAt(i + 3) !== 115 || text.charCodeAt(i + 4) !== 101) return null;
        i += 5;
      } else if (c === 110) {
        if (text.charCodeAt(i + 1) !== 117 || text.charCodeAt(i + 2) !== 108 || text.charCodeAt(i + 3) !== 108) return null;
        i += 4;
      } else {
        return null;
      }
    } else {
      while (i < text.length) {
        const code = text.charCodeAt(i);
        if (code === 44 || code === 93 || code === 125 || code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09) break;
        if (code === 46 || code === 101 || code === 69) simpleInteger = false;
        i++;
      }
    }
    if (collectLiterals && (c === 45 || (c >= 48 && c <= 57))) {
      const length = i - start;
      if (!simpleInteger || length > 15 || (length === 2 && c === 45)) {
        const raw = text.slice(start, i);
        const value = Number(raw);
        if (!Number.isFinite(value) || raw !== String(value)) numberLiterals[currentPath()] = raw;
      }
    }
    if (!copy(start, i)) return null;
    state = 2;
  }
  return { text: decodeOutput(output, used, wide), numberLiterals };
}

/**
 * 解析并排版 JSON，保留原文数字字面量及 JSON.parse 的 key 排序/去重语义。
 * indent=null 表示压缩；仅树形显示需要额外返回数字字面量表。
 * includeData=false 时允许单遍校验直接排版，仅在语法错误或需要规范化时回退 JSON.parse。
 */
export function formatJson(text, { indent = '2', includeNumberLiterals = false, includeData = true, parsed = null } = {}) {
  const indentUnit = indent === null ? null : normalizeJsonIndent(indent);
  const tryDirectFirst = !includeData && !parsed && typeof text === 'string';
  if (tryDirectFirst) {
    const direct = formatJsonTextDirect(text, indentUnit, includeNumberLiterals, true);
    if (direct) return { text: direct.text, data: undefined, numberLiterals: direct.numberLiterals };
  }
  // parsed 只由持有同一原文解析结果的 Worker 会话传入，避免切换视图重复解析。
  const data = parsed ? parsed.data : JSON.parse(text);
  let numberLiterals = parsed?.numberLiterals ?? null;
  if (!tryDirectFirst) {
    const direct = formatJsonTextDirect(text, indentUnit, includeNumberLiterals && numberLiterals === null, false);
    if (direct) {
      numberLiterals ??= direct.numberLiterals;
      return { text: direct.text, data: includeData ? data : undefined, numberLiterals };
    }
  }
  numberLiterals ??= collectNumberLiterals(text);
  return { text: stringifyJson(data, numberLiterals, indentUnit), data: includeData ? data : undefined, numberLiterals };
}
