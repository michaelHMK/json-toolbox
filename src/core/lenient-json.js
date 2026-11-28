import { errorLocationAtPosition } from './parse-error.js';

const KIND_ROOT = 0;
const KIND_OBJECT = 1;
const KIND_ARRAY = 2;

const STATE_VALUE = 0;
const STATE_VALUE_OR_END = 1;
const STATE_KEY = 2;
const STATE_KEY_OR_END = 3;
const STATE_COLON = 4;
const STATE_COMMA = 5;
const STATE_END = 6;

const MAX_CONTAINER_DEPTH = 4 * 1024 * 1024;
const MAX_OUTPUT_LENGTH = 0x1fffffe8;
const CHUNK_FLUSH_SIZE = 65536;
const UNICODE_ZS_RE = /\p{Zs}/u;
const ID_START_RE = /^[\p{Lu}\p{Ll}\p{Lt}\p{Lm}\p{Lo}\p{Nl}$_]$/u;
const ID_PART_RE = /^[\p{Lu}\p{Ll}\p{Lt}\p{Lm}\p{Lo}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$_\u200C\u200D]$/u;

const isDigit = (c) => c >= 48 && c <= 57;
const isHex = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);

function isJson5Whitespace(text, i) {
  const c = text.charCodeAt(i);
  if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12) return true;
  if (c < 128) return false;
  if (c === 0x00a0 || c === 0xfeff || c === 0x2028 || c === 0x2029) return true;
  return UNICODE_ZS_RE.test(text[i]);
}

function isLineTerminator(c) {
  return c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
}

function isAsciiIdStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 36 || c === 95;
}

function isAsciiIdPart(c) {
  return isAsciiIdStart(c) || (c >= 48 && c <= 57);
}

function escapeControlChar(code) {
  if (code === 8) return '\\b';
  if (code === 9) return '\\t';
  if (code === 12) return '\\f';
  return '\\u' + code.toString(16).padStart(4, '0');
}

function failAt(text, position, message) {
  const safePos = Math.max(0, Math.min(position, text.length));
  const loc = errorLocationAtPosition(text, safePos);
  const error = new SyntaxError(message);
  error.code = 'INVALID_JSON';
  error.position = loc.position;
  error.line = loc.line;
  error.column = loc.column;
  return error;
}

/**
 * Single-pass iterative converter from JSONC / JSON5 to strict RFC 8259 JSON.
 * Returns `{ text, mapOffset(pos) }` or throws `SyntaxError` with original
 * `{ position, line, column }` metadata. Infinity / NaN are rejected per D6.
 */
export function convertLenientJson(input, { trackOffsets = true } = {}) {
  if (typeof input !== 'string') {
    throw new SyntaxError('Input is not valid JSON');
  }
  const len = input.length;
  const chunks = [];
  let buf = '';
  const anchorsOut = trackOffsets ? [0] : null;
  const anchorsSrc = trackOffsets ? [0] : null;
  let outLen = 0;
  let lastDelta = 0;

  let stack = new Uint8Array(64);
  stack[0] = (KIND_ROOT << 3) | STATE_VALUE;
  let depth = 1;
  let i = 0;

  function recordAnchor(outPos, srcPos) {
    if (!trackOffsets) return;
    const last = anchorsOut.length - 1;
    if (anchorsOut[last] === outPos) {
      anchorsSrc[last] = srcPos;
    } else {
      anchorsOut.push(outPos);
      anchorsSrc.push(srcPos);
    }
    lastDelta = srcPos - outPos;
  }

  function pushBuffered(str) {
    if (outLen + str.length > MAX_OUTPUT_LENGTH) {
      throw new RangeError('Formatted JSON exceeds the maximum string length');
    }
    outLen += str.length;
    if (str.length >= CHUNK_FLUSH_SIZE) {
      if (buf) {
        chunks.push(buf);
        buf = '';
      }
      chunks.push(str);
      return;
    }
    buf += str;
    if (buf.length >= CHUNK_FLUSH_SIZE) {
      chunks.push(buf);
      buf = '';
    }
  }

  function emit(str, srcStart, srcEnd) {
    if (!str) return;
    if (trackOffsets && srcStart - outLen !== lastDelta) {
      recordAnchor(outLen, srcStart);
    }
    pushBuffered(str);
    if (trackOffsets && srcEnd - outLen !== lastDelta) {
      recordAnchor(outLen, srcEnd);
    }
  }

  function emitChar(ch, srcStart, srcEnd) {
    emit(ch, srcStart, srcEnd);
  }

  function push(frame) {
    if (depth >= MAX_CONTAINER_DEPTH) {
      throw failAt(input, i, 'JSON nesting exceeds maximum supported depth');
    }
    if (depth === stack.length) {
      const grown = new Uint8Array(Math.min(MAX_CONTAINER_DEPTH, stack.length * 2));
      grown.set(stack);
      stack = grown;
    }
    stack[depth++] = frame;
  }

  function skipWsAndComments() {
    while (i < len) {
      if (isJson5Whitespace(input, i)) {
        i++;
        continue;
      }
      if (input.charCodeAt(i) === 47 && i + 1 < len) {
        const next = input.charCodeAt(i + 1);
        if (next === 47) {
          i += 2;
          while (i < len && !isLineTerminator(input.charCodeAt(i))) i++;
          continue;
        }
        if (next === 42) {
          const commentStart = i;
          i += 2;
          let closed = false;
          while (i + 1 < len) {
            if (input.charCodeAt(i) === 42 && input.charCodeAt(i + 1) === 47) {
              i += 2;
              closed = true;
              break;
            }
            i++;
          }
          if (!closed) {
            throw failAt(input, commentStart, 'Unterminated block comment in JSON');
          }
          continue;
        }
      }
      break;
    }
  }

  function readHexDigits(count, errOffset, errMessage) {
    if (i + count > len) throw failAt(input, errOffset, errMessage);
    for (let k = 0; k < count; k++) {
      if (!isHex(input.charCodeAt(i + k))) {
        throw failAt(input, errOffset, errMessage);
      }
    }
    const hex = input.slice(i, i + count);
    i += count;
    return hex;
  }

  function readQuotedString(quoteCode) {
    const tokenStart = i;
    i++; // opening quote
    const outParts = ['"'];
    let runStart = i;

    function flushRun() {
      if (i > runStart) outParts.push(input.slice(runStart, i));
    }

    while (i < len) {
      const c = input.charCodeAt(i);
      if (c === quoteCode) {
        flushRun();
        i++;
        outParts.push('"');
        const out = outParts.length === 1 ? outParts[0] : outParts.join('');
        emit(out, tokenStart, i);
        return;
      }
      if (c === 10 || c === 13) {
        throw failAt(input, i, 'Unterminated string literal in JSON');
      }
      if (c === 34 && quoteCode === 39) {
        // Unescaped double quote inside single-quoted string must be escaped in JSON.
        flushRun();
        outParts.push('\\"');
        i++;
        runStart = i;
        continue;
      }
      if (c < 0x20) {
        flushRun();
        outParts.push(escapeControlChar(c));
        i++;
        runStart = i;
        continue;
      }
      if (c === 92) {
        flushRun();
        const escPos = i;
        i++;
        if (i >= len) throw failAt(input, len, 'Unterminated string literal in JSON');
        const esc = input.charCodeAt(i);
        if (esc === 13) {
          // \<CR> or \<CRLF> line continuation
          i++;
          if (i < len && input.charCodeAt(i) === 10) i++;
        } else if (esc === 10 || esc === 0x2028 || esc === 0x2029) {
          i++;
        } else if (esc === 34) {
          outParts.push('\\"');
          i++;
        } else if (esc === 39) {
          outParts.push("'");
          i++;
        } else if (esc === 92) {
          outParts.push('\\\\');
          i++;
        } else if (esc === 47) {
          outParts.push('/');
          i++;
        } else if (esc === 98) {
          outParts.push('\\b');
          i++;
        } else if (esc === 102) {
          outParts.push('\\f');
          i++;
        } else if (esc === 110) {
          outParts.push('\\n');
          i++;
        } else if (esc === 114) {
          outParts.push('\\r');
          i++;
        } else if (esc === 116) {
          outParts.push('\\t');
          i++;
        } else if (esc === 118) {
          outParts.push('\\u000b');
          i++;
        } else if (esc === 48) {
          if (i + 1 < len && isDigit(input.charCodeAt(i + 1))) {
            throw failAt(input, escPos, 'Octal escape sequence is not valid in JSON');
          }
          outParts.push('\\u0000');
          i++;
        } else if (esc >= 49 && esc <= 57) {
          throw failAt(input, escPos, 'Octal escape sequence is not valid in JSON');
        } else if (esc === 120) {
          i++;
          const hex = readHexDigits(2, escPos, 'Invalid hex escape sequence in JSON string');
          outParts.push('\\u00', hex);
        } else if (esc === 117) {
          i++;
          const hex = readHexDigits(4, escPos, 'Invalid Unicode escape sequence in JSON string');
          outParts.push('\\u', hex);
        } else {
          // NonEscapeCharacter in JSON5 (e.g. \a -> a)
          const ch = input[i];
          if (esc < 0x20) outParts.push(escapeControlChar(esc));
          else if (esc === 34) outParts.push('\\"');
          else if (esc === 92) outParts.push('\\\\');
          else outParts.push(ch);
          i++;
        }
        runStart = i;
        continue;
      }
      i++;
    }
    throw failAt(input, len, 'Unterminated string literal in JSON');
  }

  function readIdentifierKey() {
    const tokenStart = i;
    let key = '';
    let hasEscape = false;
    let first = true;

    while (i < len) {
      const c = input.charCodeAt(i);
      if (c === 92) {
        const escPos = i;
        if (i + 1 >= len || input.charCodeAt(i + 1) !== 117) {
          throw failAt(input, escPos, 'Invalid escape in JSON object key');
        }
        i += 2;
        const hex = readHexDigits(4, escPos, 'Invalid Unicode escape in JSON object key');
        const codeUnit = parseInt(hex, 16);
        const ch = String.fromCharCode(codeUnit);
        const valid = first ? ID_START_RE.test(ch) : ID_PART_RE.test(ch);
        if (!valid) {
          throw failAt(input, escPos, 'Invalid identifier character in JSON object key');
        }
        if (!hasEscape) {
          key = input.slice(tokenStart, escPos);
          hasEscape = true;
        }
        key += ch;
        first = false;
        continue;
      }
      if (first ? isAsciiIdStart(c) : isAsciiIdPart(c)) {
        if (hasEscape) key += input[i];
        i++;
        first = false;
        continue;
      }
      if (c >= 128) {
        const cp = input.codePointAt(i);
        const ch = String.fromCodePoint(cp);
        const valid = first ? ID_START_RE.test(ch) : ID_PART_RE.test(ch);
        if (valid) {
          if (hasEscape) key += ch;
          i += ch.length;
          first = false;
          continue;
        }
      }
      break;
    }

    if (first) {
      throw failAt(input, tokenStart, 'Unexpected token in JSON object key');
    }
    if (!hasEscape) {
      key = input.slice(tokenStart, i);
    }
    emit(JSON.stringify(key), tokenStart, i);
  }

  function readNumberOrNonFinite() {
    const tokenStart = i;
    const first = input.charCodeAt(i);

    if (first === 73) { // 'I'
      if (input.startsWith('Infinity', i)) {
        throw failAt(input, tokenStart, 'Non-finite number Infinity is not valid in JSON');
      }
      throw failAt(input, tokenStart, 'Unexpected token in JSON');
    }
    if (first === 78) { // 'N'
      if (input.startsWith('NaN', i)) {
        throw failAt(input, tokenStart, 'Non-finite number NaN is not valid in JSON');
      }
      throw failAt(input, tokenStart, 'Unexpected token in JSON');
    }

    let sign = '';
    if (first === 43 || first === 45) { // '+' or '-'
      sign = first === 45 ? '-' : '';
      i++;
      if (i >= len) {
        throw failAt(input, i, 'Unexpected end of JSON number');
      }
      if (input.startsWith('Infinity', i)) {
        throw failAt(input, tokenStart, 'Non-finite number Infinity is not valid in JSON');
      }
      if (input.startsWith('NaN', i)) {
        throw failAt(input, tokenStart, 'Non-finite number NaN is not valid in JSON');
      }
    }

    const c = input.charCodeAt(i);

    // Hexadecimal integer: 0x... / 0X...
    if (c === 48 && i + 1 < len && (input.charCodeAt(i + 1) === 120 || input.charCodeAt(i + 1) === 88)) {
      i += 2;
      const hexStart = i;
      while (i < len && isHex(input.charCodeAt(i))) i++;
      if (i === hexStart) {
        throw failAt(input, i, 'Invalid hexadecimal number in JSON');
      }
      const magnitude = BigInt('0x' + input.slice(hexStart, i));
      const out = sign === '-'
        ? (magnitude === 0n ? '-0' : '-' + magnitude.toString(10))
        : magnitude.toString(10);
      emit(out, tokenStart, i);
      return;
    }

    let intPart = '';
    let fracPart = '';
    let hasDot = false;

    if (c === 46) { // Leading dot: .5
      hasDot = true;
      i++;
      const fracStart = i;
      while (i < len && isDigit(input.charCodeAt(i))) i++;
      if (i === fracStart) {
        throw failAt(input, i, 'Invalid number literal in JSON');
      }
      intPart = '0';
      fracPart = input.slice(fracStart, i);
    } else if (isDigit(c)) {
      const intStart = i;
      if (c === 48) {
        i++;
        if (i < len && isDigit(input.charCodeAt(i))) {
          throw failAt(input, i, 'Leading zero is not valid in JSON number');
        }
      } else {
        i++;
        while (i < len && isDigit(input.charCodeAt(i))) i++;
      }
      intPart = input.slice(intStart, i);
      if (i < len && input.charCodeAt(i) === 46) {
        hasDot = true;
        i++;
        const fracStart = i;
        while (i < len && isDigit(input.charCodeAt(i))) i++;
        fracPart = input.slice(fracStart, i);
      }
    } else {
      throw failAt(input, i, 'Invalid number literal in JSON');
    }

    let expPart = '';
    if (i < len && (input.charCodeAt(i) === 101 || input.charCodeAt(i) === 69)) {
      const expStart = i;
      i++;
      if (i < len && (input.charCodeAt(i) === 43 || input.charCodeAt(i) === 45)) i++;
      const expDigitsStart = i;
      while (i < len && isDigit(input.charCodeAt(i))) i++;
      if (i === expDigitsStart) {
        throw failAt(input, i, 'Invalid exponent in JSON number');
      }
      expPart = input.slice(expStart, i);
    }

    const decimal = hasDot && fracPart.length > 0
      ? sign + intPart + '.' + fracPart + expPart
      : sign + intPart + expPart;
    emit(decimal, tokenStart, i);
  }

  function readKeyword(literal) {
    const start = i;
    for (let n = 0; n < literal.length; n++) {
      if (i >= len || input.charCodeAt(i) !== literal.charCodeAt(n)) {
        throw failAt(input, i, 'Unexpected token in JSON');
      }
      i++;
    }
    emit(literal, start, i);
  }

  while (true) {
    skipWsAndComments();
    const frame = stack[depth - 1];
    const kind = frame >> 3;
    const state = frame & 7;
    const c = i < len ? input.charCodeAt(i) : -1;

    if (state === STATE_END) {
      if (i !== len) throw failAt(input, i, 'Unexpected trailing content in JSON');
      break;
    }

    if (state === STATE_COMMA) {
      const closeCode = kind === KIND_ARRAY ? 93 : 125;
      if (c === closeCode) {
        depth--;
        emitChar(kind === KIND_ARRAY ? ']' : '}', i, i + 1);
        i++;
        continue;
      }
      if (c !== 44) {
        throw failAt(input, i, 'Expected comma or closing bracket in JSON');
      }
      const commaPos = i;
      i++;
      skipWsAndComments();
      if (i < len && input.charCodeAt(i) === closeCode) {
        // Trailing comma: omit comma and close container.
        depth--;
        emitChar(kind === KIND_ARRAY ? ']' : '}', i, i + 1);
        i++;
        continue;
      }
      emitChar(',', commaPos, commaPos + 1);
      stack[depth - 1] = (kind << 3) | (kind === KIND_ARRAY ? STATE_VALUE : STATE_KEY);
      continue;
    }

    if (state === STATE_KEY || state === STATE_KEY_OR_END) {
      if (state === STATE_KEY_OR_END && c === 125) {
        depth--;
        emitChar('}', i, i + 1);
        i++;
        continue;
      }
      if (c === 34 || c === 39) {
        readQuotedString(c);
      } else if (i < len) {
        readIdentifierKey();
      } else {
        throw failAt(input, i, 'Unexpected end of JSON object');
      }
      stack[depth - 1] = (kind << 3) | STATE_COLON;
      continue;
    }

    if (state === STATE_COLON) {
      if (c !== 58) {
        throw failAt(input, i, 'Expected colon after object key in JSON');
      }
      emitChar(':', i, i + 1);
      i++;
      stack[depth - 1] = (kind << 3) | STATE_VALUE;
      continue;
    }

    if (state === STATE_VALUE_OR_END && c === 93) {
      depth--;
      emitChar(']', i, i + 1);
      i++;
      continue;
    }

    if (i >= len) {
      throw failAt(input, len, 'Unexpected end of JSON input');
    }

    stack[depth - 1] = (kind << 3) | (kind === KIND_ROOT ? STATE_END : STATE_COMMA);

    if (c === 123 || c === 91) {
      emitChar(c === 123 ? '{' : '[', i, i + 1);
      push(c === 123
        ? ((KIND_OBJECT << 3) | STATE_KEY_OR_END)
        : ((KIND_ARRAY << 3) | STATE_VALUE_OR_END));
      i++;
    } else if (c === 34 || c === 39) {
      readQuotedString(c);
    } else if (c === 116) {
      readKeyword('true');
    } else if (c === 102) {
      readKeyword('false');
    } else if (c === 110) {
      readKeyword('null');
    } else if (c === 43 || c === 45 || c === 46 || isDigit(c) || c === 73 || c === 78) {
      readNumberOrNonFinite();
    } else {
      throw failAt(input, i, 'Unexpected token in JSON');
    }
  }

  recordAnchor(outLen, len);
  if (buf) chunks.push(buf);
  const text = chunks.length === 1 ? chunks[0] : chunks.join('');

  return {
    text,
    mapOffset(pos) {
      const target = Math.max(0, Math.min(pos, outLen));
      if (!trackOffsets) return target;
      let lo = 0;
      let hi = anchorsOut.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (anchorsOut[mid] <= target) lo = mid;
        else hi = mid - 1;
      }
      if (lo + 1 < anchorsOut.length) {
        const outSpan = anchorsOut[lo + 1] - anchorsOut[lo];
        const srcSpan = anchorsSrc[lo + 1] - anchorsSrc[lo];
        if (outSpan === srcSpan) {
          return anchorsSrc[lo] + (target - anchorsOut[lo]);
        }
      }
      return anchorsSrc[lo];
    },
  };
}
