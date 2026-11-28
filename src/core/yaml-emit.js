import { appendJsonPath } from './json-path.js';

const MAX_OUTPUT_LENGTH = 0x1fffffe8;
const CHUNK_FLUSH_SIZE = 65536;

// YAML 1.1 (PyYAML) + YAML 1.2 reserved word scalars that must be quoted.
const RESERVED_SCALAR_RE = /^(?:true|false|null|yes|no|on|off|y|n|~|=|<<)$/i;
// Numeric-looking scalars across YAML 1.1 and 1.2 (including underscores, leading zeros, octals, hex, binary, sexagesimal, inf/nan).
const NUMERIC_SCALAR_RE = /^[+-]?(?:0|[1-9][0-9_]*|0[0-9_]+)(?:\.[0-9_]*)?(?:[eE][+-]?[0-9_]+)?$|^[+-]?\.[0-9_]+(?:[eE][+-]?[0-9_]+)?$|^[+-]?0[xXoObB][0-9a-fA-F_]+$|^[+-]?\.(?:inf|infinity|nan)$|^[+-]?[0-9]+(?::[0-5]?[0-9])+(?:\.[0-9_]*)?$/i;
// YAML 1.1 timestamp strings (PyYAML resolves unquoted ISO dates/times to datetime objects).
const TIMESTAMP_SCALAR_RE = /^\d{4}-\d{1,2}-\d{1,2}(?:[tT \t]\d{1,2}:\d{2}:\d{2}(?:\.\d*)?(?:[ \t]*(?:Z|[-+]\d{1,2}(?::\d{2})?))?)?$/;
// Leading characters that act as YAML indicators or reserved markers.
const INDICATOR_START_CHARS = new Set("-?:,[]{}#&*!|>'\"%@`");

function hasSpecialOrControlChars(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true;
    if (code === 0x2028 || code === 0x2029 || code === 0xfeff) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= str.length) return true;
      const low = str.charCodeAt(i + 1);
      if (low < 0xdc00 || low > 0xdfff) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isWhitespaceCode(code) {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d
    || code === 0x0b || code === 0x0c || code === 0x00a0
    || code === 0x2028 || code === 0x2029 || code === 0xfeff;
}

function needsQuotes(str) {
  if (str.length === 0) return true;
  if (isWhitespaceCode(str.charCodeAt(0)) || isWhitespaceCode(str.charCodeAt(str.length - 1))) {
    return true;
  }
  if (INDICATOR_START_CHARS.has(str[0])) return true;
  if (str.startsWith('---') || str.startsWith('...')) return true;
  if (str.endsWith(':')) return true;
  if (str.includes(': ') || str.includes(':\t') || str.includes(' #') || str.includes('\t#')) {
    return true;
  }
  if (RESERVED_SCALAR_RE.test(str) || NUMERIC_SCALAR_RE.test(str) || TIMESTAMP_SCALAR_RE.test(str)) {
    return true;
  }
  return false;
}

function quoteDoubleString(str) {
  let out = '"';
  let runStart = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    let esc = null;
    if (code === 34) esc = '\\"';
    else if (code === 92) esc = '\\\\';
    else if (code === 0) esc = '\\0';
    else if (code === 7) esc = '\\a';
    else if (code === 8) esc = '\\b';
    else if (code === 9) esc = '\\t';
    else if (code === 10) esc = '\\n';
    else if (code === 11) esc = '\\v';
    else if (code === 12) esc = '\\f';
    else if (code === 13) esc = '\\r';
    else if (code === 0x1b) esc = '\\e';
    else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)
      || code === 0x2028 || code === 0x2029 || code === 0xfeff) {
      esc = '\\u' + code.toString(16).padStart(4, '0');
    } else if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 < str.length) {
        const low = str.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          i++;
          continue;
        }
      }
      esc = '\\u' + code.toString(16).padStart(4, '0');
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      esc = '\\u' + code.toString(16).padStart(4, '0');
    }
    if (esc !== null) {
      if (i > runStart) out += str.slice(runStart, i);
      out += esc;
      runStart = i + 1;
    }
  }
  if (runStart < str.length) out += str.slice(runStart);
  return out + '"';
}

function formatSingleLineString(str) {
  if (hasSpecialOrControlChars(str)) {
    return quoteDoubleString(str);
  }
  if (!needsQuotes(str)) {
    return str;
  }
  // Prefer single quotes for printable quoted strings to avoid backslash escaping.
  return "'" + str.replace(/'/g, "''") + "'";
}

function canUseBlockScalar(str) {
  if (!str.includes('\n')) return false;
  let hasVisible = false;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 10) continue;
    // Block scalars chomp trailing whitespace-only lines cleanly only when visible content exists;
    // strings composed purely of spaces and newlines (e.g. " \n", " \n ") fall back to double quotes.
    if (code !== 32) hasVisible = true;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)
      || code === 0x2028 || code === 0x2029 || code === 0xfeff) {
      return false;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= str.length) return false;
      const low = str.charCodeAt(i + 1);
      if (low < 0xdc00 || low > 0xdfff) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return hasVisible;
}

function emitBlockScalar(str, contentIndentStr) {
  let chomp = '-';
  let body = str;
  if (str.endsWith('\n\n')) {
    chomp = '+';
    body = str.slice(0, -1);
  } else if (str.endsWith('\n')) {
    chomp = '';
    body = str.slice(0, -1);
  }

  const lines = body.split('\n');
  let needsIndentIndicator = false;
  let sawFirstNonEmpty = false;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    if (line.length > 0 && !sawFirstNonEmpty) {
      sawFirstNonEmpty = true;
      if (line.charCodeAt(0) === 32) {
        needsIndentIndicator = true;
      }
      break;
    }
  }

  const header = '|' + (needsIndentIndicator ? '2' : '') + chomp;
  const parts = [header, '\n'];
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].length > 0) parts.push(contentIndentStr, lines[k]);
    parts.push('\n');
  }
  return parts.join('');
}

/**
 * Emit YAML 1.2 (also safe for YAML 1.1 readers) from parsed JSON data and
 * preserved `numberLiterals`. Uses iterative traversal and chunked output.
 */
export function emitYaml(data, { numberLiterals = null } = {}) {
  const hasLiterals = Boolean(numberLiterals && Object.keys(numberLiterals).length > 0);
  let indentCache = [''];
  function indentOf(level) {
    while (indentCache.length <= level) {
      indentCache.push(indentCache[indentCache.length - 1] + '  ');
    }
    return indentCache[level];
  }

  const chunks = [];
  let buf = '';
  let totalLength = 0;
  function pushChunk(text) {
    if (!text) return;
    if (totalLength + text.length > MAX_OUTPUT_LENGTH) {
      throw new RangeError('Formatted YAML exceeds the maximum string length');
    }
    totalLength += text.length;
    if (text.length >= CHUNK_FLUSH_SIZE) {
      if (buf) {
        chunks.push(buf);
        buf = '';
      }
      chunks.push(text);
      return;
    }
    buf += text;
    if (buf.length >= CHUNK_FLUSH_SIZE) {
      chunks.push(buf);
      buf = '';
    }
  }

  const pathSegments = [];
  const encodedPaths = [''];
  let pathLen = 0;
  let encodedLen = 1;

  function setSegment(depth, segment) {
    pathSegments[depth] = segment;
    pathLen = depth + 1;
    if (encodedLen > depth + 1) encodedLen = depth + 1;
  }

  function currentPath() {
    for (let n = encodedLen; n <= pathLen; n++) {
      encodedPaths[n] = appendJsonPath(encodedPaths[n - 1], pathSegments[n - 1]);
    }
    encodedLen = pathLen + 1;
    return encodedPaths[pathLen];
  }

  function formatNumber(value) {
    if (hasLiterals) {
      const literal = numberLiterals[currentPath()];
      if (literal !== undefined) return literal;
    }
    if (Object.is(value, -0)) return '-0';
    return String(value);
  }

  function emitScalarValue(value, contentIndentLevel) {
    if (value === null) return 'null\n';
    if (typeof value === 'boolean') return (value ? 'true' : 'false') + '\n';
    if (typeof value === 'number') return formatNumber(value) + '\n';
    if (typeof value === 'string') {
      if (canUseBlockScalar(value)) {
        return emitBlockScalar(value, indentOf(contentIndentLevel));
      }
      return formatSingleLineString(value) + '\n';
    }
    return quoteDoubleString(String(value)) + '\n';
  }

  function containerInfo(value) {
    if (value === null || typeof value !== 'object') return null;
    if (Array.isArray(value)) return { isArray: true, keys: null, length: value.length };
    const keys = Object.keys(value);
    return { isArray: false, keys, length: keys.length };
  }

  const rootInfo = containerInfo(data);
  if (!rootInfo) {
    return emitScalarValue(data, 1);
  }
  if (rootInfo.length === 0) {
    return rootInfo.isArray ? '[]\n' : '{}\n';
  }

  // Frame: { value, isArray, keys, index, length, indentLevel, pathDepth, inlineFirstKey }
  const stack = [{
    value: data,
    isArray: rootInfo.isArray,
    keys: rootInfo.keys,
    index: 0,
    length: rootInfo.length,
    indentLevel: 0,
    pathDepth: 0,
    inlineFirstKey: false,
  }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.length) {
      stack.pop();
      if (hasLiterals) {
        pathLen = frame.pathDepth;
        if (encodedLen > pathLen + 1) encodedLen = pathLen + 1;
      }
      continue;
    }

    const idx = frame.index++;
    const indentStr = indentOf(frame.indentLevel);

    if (frame.isArray) {
      if (hasLiterals) setSegment(frame.pathDepth, idx);
      const item = frame.value[idx];
      const info = containerInfo(item);
      pushChunk(indentStr + '-');
      if (!info) {
        pushChunk(' ');
        pushChunk(emitScalarValue(item, frame.indentLevel + 1));
      } else if (info.length === 0) {
        pushChunk(info.isArray ? ' []\n' : ' {}\n');
      } else {
        const inlineFirstKey = !info.isArray;
        if (!inlineFirstKey) pushChunk('\n');
        stack.push({
          value: item,
          isArray: info.isArray,
          keys: info.keys,
          index: 0,
          length: info.length,
          indentLevel: frame.indentLevel + 1,
          pathDepth: frame.pathDepth + 1,
          inlineFirstKey,
        });
      }
    } else {
      const key = frame.keys[idx];
      if (hasLiterals) setSegment(frame.pathDepth, key);
      const child = frame.value[key];
      const formattedKey = key.includes('\n') ? quoteDoubleString(key) : formatSingleLineString(key);
      const explicitKey = formattedKey.length > 1024;
      const isInlineFirst = idx === 0 && frame.inlineFirstKey;

      if (explicitKey) {
        pushChunk(isInlineFirst ? '\n' : '');
        pushChunk(indentStr + '? ' + formattedKey + '\n' + indentStr + ':');
      } else if (isInlineFirst) {
        pushChunk(' ' + formattedKey + ':');
      } else {
        pushChunk(indentStr + formattedKey + ':');
      }

      const info = containerInfo(child);
      if (!info) {
        pushChunk(' ');
        pushChunk(emitScalarValue(child, frame.indentLevel + 1));
      } else if (info.length === 0) {
        pushChunk(info.isArray ? ' []\n' : ' {}\n');
      } else {
        pushChunk('\n');
        stack.push({
          value: child,
          isArray: info.isArray,
          keys: info.keys,
          index: 0,
          length: info.length,
          indentLevel: frame.indentLevel + 1,
          pathDepth: frame.pathDepth + 1,
          inlineFirstKey: false,
        });
      }
    }
  }

  if (buf) chunks.push(buf);
  return chunks.length === 1 ? chunks[0] : chunks.join('');
}
