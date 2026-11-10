import { appendJsonPath, PATH_SEP } from './json-path.js';

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
  const objectKeys = [];
  const objectKeySets = [];
  const pathSegments = [];
  const encodedPaths = [''];
  const chunks = restore ? [] : null;
  let depth = 0;
  let i = 0;
  let state = 0; // 0=值，1=对象 key，2=值结束
  let copyFrom = 0;

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
        const seen = objectKeys[frame];
        const seenSet = objectKeySets[frame];
        const duplicate = seenSet ? seenSet.has(key) : seen.includes(key);
        if (duplicate) {
          const prefix = currentPath();
          const descendants = prefix + PATH_SEP;
          for (const stored in numberLiterals) {
            if (stored === prefix || stored.startsWith(descendants)) delete numberLiterals[stored];
          }
        }
        if (seenSet) {
          seenSet.add(key);
        } else {
          seen.push(key);
          if (seen.length === 16) objectKeySets[frame] = new Set(seen);
        }
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
          const keys = objectKeys[depth] || [];
          keys.length = 0;
          objectKeys[depth] = keys;
          objectKeySets[depth] = null;
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
        objectKeys[depth] = null;
        objectKeySets[depth] = null;
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
        if (!Number.isFinite(value) || raw !== String(value)) numberLiterals[currentPath()] = raw;
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

  if (!restore) return numberLiterals;
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

function stringifyJsonCompact(value, numberLiterals) {
  return restoreNumberLiterals(JSON.stringify(value), numberLiterals);
}

function stringifyJsonPretty(value, numberLiterals, indentUnit) {
  return restoreNumberLiterals(JSON.stringify(value, null, indentUnit), numberLiterals);
}

function normalizeJsonIndent(indent) {
  if (indent === 'tab') return '\t';
  const value = Number(indent) || 2;
  if (value <= 0) return null;
  return ' '.repeat(Math.min(10, Math.floor(value)));
}

// 常见输入直接生成结果；需要原生 key 排序、去重或字符串规范化时返回 null
function formatJsonTextDirect(text, indentUnit) {
  const pretty = indentUnit !== null;
  const lineIndents = pretty ? ['\n'] : null;
  const parentIsArray = [];
  const objectKeys = [];
  const objectKeySets = [];
  let depth = 0;
  let i = 0;
  let state = 0; // 0=值，1=对象 key，2=值结束
  let output = '';

  function lineIndent(level) {
    if (lineIndents[level] === undefined) lineIndents[level] = '\n' + indentUnit.repeat(level);
    return lineIndents[level];
  }

  while (true) {
    if (state === 2) {
      if (depth === 0) break;
      i = skipJsonWhitespace(text, i);
      if (text.charCodeAt(i) === 44) {
        output += ',';
        i++;
        if (pretty) output += lineIndent(depth);
        state = parentIsArray[depth - 1] ? 0 : 1;
      } else {
        const close = text[i++];
        depth--;
        if (pretty) output += lineIndent(depth);
        output += close;
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
      const token = text.slice(start, i);
      const key = escaped ? JSON.parse(token) : token.slice(1, -1);
      const frame = depth - 1;
      const seen = objectKeys[frame];
      const seenSet = objectKeySets[frame];
      if ((key.charCodeAt(0) >= 48 && key.charCodeAt(0) <= 57) || (seenSet ? seenSet.has(key) : seen.includes(key))) return null;
      if (seenSet) {
        seenSet.add(key);
      } else {
        seen.push(key);
        if (seen.length === 16) objectKeySets[frame] = new Set(seen);
      }
      output += token + (pretty ? ': ' : ':');
      i = skipJsonWhitespace(text, i) + 1;
      state = 0;
      continue;
    }

    const c = text.charCodeAt(i);
    if (c === 123 || c === 91) {
      const isArray = c === 91;
      const close = isArray ? ']' : '}';
      const end = skipJsonWhitespace(text, i + 1);
      if (text.charCodeAt(end) === close.charCodeAt(0)) {
        output += text[i] + close;
        i = end + 1;
        state = 2;
        continue;
      }
      parentIsArray[depth] = isArray;
      if (isArray) {
        objectKeys[depth] = null;
        objectKeySets[depth] = null;
      } else {
        const keys = objectKeys[depth] || [];
        keys.length = 0;
        objectKeys[depth] = keys;
        objectKeySets[depth] = null;
      }
      depth++;
      output += text[i];
      if (pretty) output += lineIndent(depth);
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
      output += text.slice(start, i);
      state = 2;
      continue;
    }
    const start = i;
    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (code === 44 || code === 93 || code === 125 || code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09) break;
      i++;
    }
    output += text.slice(start, i);
    state = 2;
  }
  return output;
}

/**
 * 解析并排版 JSON，保留原文数字字面量及 JSON.parse 的 key 排序/去重语义。
 * indent=null 表示压缩；仅树形显示需要额外返回数字字面量表。
 * preferStringify=true 时直接使用原生序列化；无效输入抛出 SyntaxError。
 */
export function formatJson(text, { indent = '2', includeNumberLiterals = false, parsed = null, preferStringify = false } = {}) {
  // parsed 只由持有同一原文解析结果的 Worker 会话传入，避免切换视图重复解析。
  const data = parsed ? parsed.data : JSON.parse(text);
  const indentUnit = indent === null ? null : normalizeJsonIndent(indent);
  let output = preferStringify ? null : formatJsonTextDirect(text, indentUnit);
  let numberLiterals = parsed?.numberLiterals ?? null;
  if ((output === null || includeNumberLiterals) && numberLiterals === null) {
    numberLiterals = collectNumberLiterals(text);
  }
  if (output === null) {
    output = indentUnit === null
      ? stringifyJsonCompact(data, numberLiterals)
      : stringifyJsonPretty(data, numberLiterals, indentUnit);
  }
  return { text: output, data, numberLiterals };
}
