export function errorLocationAtPosition(text, position) {
  const before = text.slice(0, position);
  const newline = before.lastIndexOf('\n');
  let line = 1;
  for (let i = 0; i < before.length; i++) if (before.charCodeAt(i) === 10) line++;
  return { position, line, column: position - newline };
}

// Only used after native parsing fails without an offset. Validate iteratively
// so deeply nested invalid documents get a location without a recursive stack.
function findInvalidPosition(text) {
  const stack = [{ kind: 'root', state: 'value' }];
  let i = 0;
  const digit = (c) => c >= '0' && c <= '9';
  function string() {
    i++;
    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (code === 34) { i++; return true; }
      if (code < 0x20) return false;
      if (code === 92) {
        i++;
        if (i === text.length) return false;
        if (text[i] === 'u') {
          for (let n = 0; n < 4; n++) {
            i++;
            if (i === text.length || !/[0-9a-f]/i.test(text[i])) return false;
          }
        } else if (!'"\\/bfnrt'.includes(text[i])) return false;
      }
      i++;
    }
    return false;
  }
  while (true) {
    while (i < text.length && ' \t\r\n'.includes(text[i])) i++;
    const frame = stack[stack.length - 1];
    const c = text[i];
    if (frame.state === 'end') return i === text.length ? null : i;
    if (frame.state === 'comma') {
      if (c === (frame.kind === 'array' ? ']' : '}')) { stack.pop(); i++; continue; }
      if (c !== ',') return i;
      frame.state = frame.kind === 'array' ? 'value' : 'key';
      i++;
      continue;
    }
    if (frame.state === 'key' || frame.state === 'keyOrEnd') {
      if (frame.state === 'keyOrEnd' && c === '}') { stack.pop(); i++; continue; }
      if (c !== '"' || !string()) return i;
      frame.state = 'colon';
      continue;
    }
    if (frame.state === 'colon') {
      if (c !== ':') return i;
      frame.state = 'value';
      i++;
      continue;
    }
    if (frame.state === 'valueOrEnd' && c === ']') { stack.pop(); i++; continue; }
    frame.state = frame.kind === 'root' ? 'end' : 'comma';
    if (c === '{' || c === '[') {
      stack.push({ kind: c === '{' ? 'object' : 'array', state: c === '{' ? 'keyOrEnd' : 'valueOrEnd' });
      i++;
    } else if (c === '"') {
      if (!string()) return i;
    } else if (c === 't' || c === 'f' || c === 'n') {
      const literal = c === 't' ? 'true' : c === 'f' ? 'false' : 'null';
      for (const expected of literal) {
        if (text[i] !== expected) return i;
        i++;
      }
    } else if (c === '-' || digit(c)) {
      if (c === '-') i++;
      if (!digit(text[i])) return i;
      if (text[i] === '0') i++;
      else while (digit(text[i])) i++;
      if (text[i] === '.') {
        i++;
        if (!digit(text[i])) return i;
        while (digit(text[i])) i++;
      }
      if (text[i] === 'e' || text[i] === 'E') {
        i++;
        if (text[i] === '+' || text[i] === '-') i++;
        if (!digit(text[i])) return i;
        while (digit(text[i])) i++;
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
