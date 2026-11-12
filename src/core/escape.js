import { errorLocationAtPosition, parseErrorLocation } from './parse-error.js';

// 转义：把任意文本变成 JSON 字符串字面量的内容（{"a":1} -> {\"a\":1}）
export function escapeJsonString(s) {
  return JSON.stringify(s).slice(1, -1);
}

function escapedWidth(code) {
  return code < 0x20 ? (code === 10 || code === 13 || code === 9 ? 2 : 6) : 1;
}

// Map the added quote and expanded control characters back to the user's text.
function originalPosition(s, wrappedPosition) {
  const target = wrappedPosition - 1;
  let offset = 0;
  for (let i = 0; i < s.length; i++) {
    offset += escapedWidth(s.charCodeAt(i));
    if (target < offset) return i;
  }
  return s.length;
}

/*
 * 去转义：接受完整的 JSON 字符串或 escapeJsonString 输出的字符串内容。
 * 内容中的原始控制字符仍可直接使用；错误偏移始终指向原始输入。
 */
export function unescapeJsonString(s) {
  try {
    const parsed = JSON.parse(s);
    if (typeof parsed === 'string') return parsed;
  } catch (error) {
    if (s.trimStart().startsWith('"')) {
      error.code = 'INVALID_ESCAPE';
      Object.assign(error, parseErrorLocation(error.message, s));
      throw error;
    }
  }
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20) {
      if (code === 10) out += '\\n';
      else if (code === 13) out += '\\r';
      else if (code === 9) out += '\\t';
      else out += '\\u' + code.toString(16).padStart(4, '0');
    } else {
      out += s[i];
    }
  }
  const wrapped = '"' + out + '"';
  try {
    return JSON.parse(wrapped);
  } catch (error) {
    const location = parseErrorLocation(error.message, wrapped);
    error.code = 'INVALID_ESCAPE';
    if (location.position !== null) {
      Object.assign(error, errorLocationAtPosition(s, originalPosition(s, location.position)));
    }
    throw error;
  }
}
