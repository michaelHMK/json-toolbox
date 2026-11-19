const MAX_VALIDATOR_DEPTH = 4 * 1024 * 1024;
// Packed frame byte: (kind << 3) | state.
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

const isDigit = (code) => code >= 48 && code <= 57;
const isHex = (code) => (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);

export function errorLocationAtPosition(text, position) {
  const limit = Math.min(position, text.length);
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < limit; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      line++;
      lineStart = i + 1;
    } else if (c === 13) {
      if (i + 1 < limit && text.charCodeAt(i + 1) === 10) i++;
      line++;
      lineStart = i + 1;
    }
  }
  return { position, line, column: position - lineStart + 1 };
}

// Only used after native parsing fails without an offset. Validate iteratively
// with a compact byte stack so deeply nested invalid documents never OOM or overflow.
function findInvalidPosition(text) {
  let stack = new Uint8Array(64);
  stack[0] = (KIND_ROOT << 3) | STATE_VALUE;
  let depth = 1;
  let i = 0;
  const len = text.length;

  function push(frame) {
    if (depth >= MAX_VALIDATOR_DEPTH) return false;
    if (depth === stack.length) {
      const grown = new Uint8Array(Math.min(MAX_VALIDATOR_DEPTH, stack.length * 2));
      grown.set(stack);
      stack = grown;
    }
    stack[depth++] = frame;
    return true;
  }

  function string() {
    i++;
    while (i < len) {
      const code = text.charCodeAt(i);
      if (code === 34) { i++; return true; }
      if (code < 0x20) return false;
      if (code === 92) {
        i++;
        if (i === len) return false;
        const esc = text.charCodeAt(i);
        if (esc === 117) {
          for (let n = 0; n < 4; n++) {
            i++;
            if (i === len || !isHex(text.charCodeAt(i))) return false;
          }
        } else if (esc !== 34 && esc !== 92 && esc !== 47 && esc !== 98
            && esc !== 102 && esc !== 110 && esc !== 114 && esc !== 116) {
          return false;
        }
      }
      i++;
    }
    return false;
  }

  while (true) {
    while (i < len) {
      const ws = text.charCodeAt(i);
      if (ws === 32 || ws === 9 || ws === 13 || ws === 10) i++;
      else break;
    }
    const frame = stack[depth - 1];
    const kind = frame >> 3;
    const state = frame & 7;
    const c = i < len ? text.charCodeAt(i) : -1;
    if (state === STATE_END) return i === len ? null : i;
    if (state === STATE_COMMA) {
      if (c === (kind === KIND_ARRAY ? 93 : 125)) { depth--; i++; continue; }
      if (c !== 44) return i;
      stack[depth - 1] = (kind << 3) | (kind === KIND_ARRAY ? STATE_VALUE : STATE_KEY);
      i++;
      continue;
    }
    if (state === STATE_KEY || state === STATE_KEY_OR_END) {
      if (state === STATE_KEY_OR_END && c === 125) { depth--; i++; continue; }
      if (c !== 34 || !string()) return i;
      stack[depth - 1] = (kind << 3) | STATE_COLON;
      continue;
    }
    if (state === STATE_COLON) {
      if (c !== 58) return i;
      stack[depth - 1] = (kind << 3) | STATE_VALUE;
      i++;
      continue;
    }
    if (state === STATE_VALUE_OR_END && c === 93) { depth--; i++; continue; }
    stack[depth - 1] = (kind << 3) | (kind === KIND_ROOT ? STATE_END : STATE_COMMA);
    if (c === 123 || c === 91) {
      if (!push(c === 123 ? ((KIND_OBJECT << 3) | STATE_KEY_OR_END) : ((KIND_ARRAY << 3) | STATE_VALUE_OR_END))) {
        return null;
      }
      i++;
    } else if (c === 34) {
      if (!string()) return i;
    } else if (c === 116 || c === 102 || c === 110) {
      const literal = c === 116 ? 'true' : c === 102 ? 'false' : 'null';
      for (let n = 0; n < literal.length; n++) {
        if (i >= len || text.charCodeAt(i) !== literal.charCodeAt(n)) return i;
        i++;
      }
    } else if (c === 45 || isDigit(c)) {
      if (c === 45) i++;
      if (i >= len || !isDigit(text.charCodeAt(i))) return i;
      if (text.charCodeAt(i) === 48) i++;
      else while (i < len && isDigit(text.charCodeAt(i))) i++;
      if (i < len && text.charCodeAt(i) === 46) {
        i++;
        if (i >= len || !isDigit(text.charCodeAt(i))) return i;
        while (i < len && isDigit(text.charCodeAt(i))) i++;
      }
      if (i < len && (text.charCodeAt(i) === 101 || text.charCodeAt(i) === 69)) {
        i++;
        if (i < len && (text.charCodeAt(i) === 43 || text.charCodeAt(i) === 45)) i++;
        if (i >= len || !isDigit(text.charCodeAt(i))) return i;
        while (i < len && isDigit(text.charCodeAt(i))) i++;
      }
    } else return i;
  }
}

// Prefer native offsets; newer V8 messages sometimes omit both position and
// line/column, in which case a small validator finds the first invalid token.
export function parseErrorLocation(message, text) {
  const result = { position: null, line: null, column: null };
  if (!message) return result;
  const posMatch = /position\s+(\d+)/i.exec(message);
  if (posMatch) result.position = Number(posMatch[1]);
  if (result.position === null && typeof text === 'string') result.position = findInvalidPosition(text);
  if (result.position !== null && typeof text === 'string') {
    return errorLocationAtPosition(text, Math.min(result.position, text.length));
  }
  const lcMatch = /line\s+(\d+)\s+column\s+(\d+)/i.exec(message);
  if (lcMatch) {
    result.line = Number(lcMatch[1]);
    result.column = Number(lcMatch[2]);
  }
  return result;
}
