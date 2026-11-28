import { LineCounter, isAlias, isMap, isPair, isScalar, isSeq, parseAllDocuments } from '../vendor/yaml.js';
import { errorLocationAtPosition } from './parse-error.js';

export const YAML_MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_LENGTH = 0x1fffffe8;
const CHUNK_FLUSH_SIZE = 65536;
const MAX_ALIAS_EXPANSIONS = 100;
const JSON_NUMBER_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const ALLOWED_TAGS = new Set([
  'tag:yaml.org,2002:str',
  'tag:yaml.org,2002:int',
  'tag:yaml.org,2002:float',
  'tag:yaml.org,2002:bool',
  'tag:yaml.org,2002:null',
  'tag:yaml.org,2002:map',
  'tag:yaml.org,2002:seq',
]);

function utf8ByteLength(str) {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function normalizeJsonIndent(indent) {
  if (indent === 'tab') return '\t';
  if (indent === null || indent === undefined || indent === false || indent === '') return null;
  const value = Number(indent);
  if (!Number.isFinite(value) || value <= 0) return null;
  return ' '.repeat(Math.min(10, Math.floor(value)));
}

function yamlError(text, lineCounter, position, code, message) {
  const safePos = typeof position === 'number'
    ? Math.max(0, Math.min(position, text.length))
    : 0;
  let line = 1;
  let column = 1;
  if (lineCounter && safePos <= text.length) {
    const lp = lineCounter.linePos(safePos);
    if (lp && typeof lp.line === 'number') {
      line = lp.line;
      column = lp.col;
    } else {
      const loc = errorLocationAtPosition(text, safePos);
      line = loc.line;
      column = loc.column;
    }
  } else {
    const loc = errorLocationAtPosition(text, safePos);
    line = loc.line;
    column = loc.column;
  }
  const error = new SyntaxError(message);
  error.code = code;
  error.position = safePos;
  error.line = line;
  error.column = column;
  return error;
}

function nodePosition(node) {
  if (!node) return 0;
  if (Array.isArray(node.range) && typeof node.range[0] === 'number') return node.range[0];
  if (node.srcToken && typeof node.srcToken.offset === 'number') return node.srcToken.offset;
  return 0;
}

function unwrapScalarToken(raw, type) {
  const s = raw.trim();
  if (!s) return '';
  if (type === 'PLAIN') return s;
  if (type === 'QUOTE_DOUBLE') {
    try {
      const parsed = JSON.parse(s);
      return typeof parsed === 'string' ? parsed.trim() : '';
    } catch {
      return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).trim() : '';
    }
  }
  if (type === 'QUOTE_SINGLE') {
    return s.startsWith("'") && s.endsWith("'")
      ? s.slice(1, -1).replace(/''/g, "'").trim()
      : '';
  }
  return '';
}

function normalizeJsonNumberLiteral(raw, value, text, lineCounter, node) {
  if (Number.isNaN(value)) {
    throw yamlError(
      text,
      lineCounter,
      nodePosition(node),
      'YAML_NON_FINITE',
      'Non-finite number (Infinity/NaN) is not valid in JSON',
    );
  }

  const token = unwrapScalarToken(raw, node?.type);
  if (/^[+-]?\.(?:inf|infinity|nan)$/i.test(token)) {
    throw yamlError(
      text,
      lineCounter,
      nodePosition(node),
      'YAML_NON_FINITE',
      'Non-finite number (Infinity/NaN) is not valid in JSON',
    );
  }

  let candidate = '';
  if (token) {
    const s = token.charCodeAt(0) === 43 ? token.slice(1) : token;
    const neg = s.charCodeAt(0) === 45;
    const unsigned = neg ? s.slice(1) : s;

    if (/^0[xX][0-9a-fA-F]+$/.test(unsigned) || /^0[oO][0-7]+$/.test(unsigned)) {
      const mag = BigInt(unsigned);
      candidate = mag === 0n ? (neg ? '-0' : '0') : ((neg ? '-' : '') + mag.toString(10));
    } else if (/^\.[0-9]+(?:[eE][+-]?[0-9]+)?$/.test(unsigned)) {
      candidate = (neg ? '-' : '') + '0' + unsigned;
    } else {
      const match = /^([0-9]+)(?:\.([0-9]*))?([eE][+-]?[0-9]+)?$/.exec(unsigned);
      if (match) {
        let [, intPart, fracPart, expPart = ''] = match;
        if (intPart.length > 1 && intPart.charCodeAt(0) === 48) {
          intPart = intPart.replace(/^0+/, '') || '0';
        }
        candidate = fracPart !== undefined && fracPart.length > 0
          ? (neg ? '-' : '') + intPart + '.' + fracPart + expPart
          : (neg ? '-' : '') + intPart + expPart;
      }
    }
  }

  if (candidate && JSON_NUMBER_RE.test(candidate)) {
    return candidate;
  }
  if (!Number.isFinite(value)) {
    throw yamlError(
      text,
      lineCounter,
      nodePosition(node),
      'YAML_NON_FINITE',
      'Non-finite number (Infinity/NaN) is not valid in JSON',
    );
  }
  return Object.is(value, -0) ? '-0' : String(value);
}

function rawNodeSlice(node, text) {
  return Array.isArray(node.range) ? text.slice(node.range[0], node.range[1]) : '';
}

function scalarKeyString(node, text, lineCounter) {
  if (node.tag && !ALLOWED_TAGS.has(node.tag)) {
    throw yamlError(text, lineCounter, nodePosition(node), 'YAML_UNSUPPORTED_TAG', `Unsupported YAML tag: ${node.tag}`);
  }
  const value = node.value;
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    return normalizeJsonNumberLiteral(rawNodeSlice(node, text), value, text, lineCounter, node);
  }
  return String(value);
}

function createChunkedWriter(indentUnit) {
  const chunks = [];
  let buf = '';
  let totalLength = 0;
  const newlineIndents = indentUnit !== null ? ['\n'] : null;

  function push(str) {
    if (!str) return;
    if (totalLength + str.length > MAX_OUTPUT_LENGTH) {
      throw new RangeError('Formatted JSON exceeds the maximum string length');
    }
    totalLength += str.length;
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

  function pushNewlineIndent(level) {
    if (!newlineIndents) return;
    while (newlineIndents.length <= level) {
      newlineIndents.push(newlineIndents[newlineIndents.length - 1] + indentUnit);
    }
    push(newlineIndents[level]);
  }

  function finish() {
    if (buf) chunks.push(buf);
    return chunks.length === 1 ? chunks[0] : chunks.join('');
  }

  return { push, pushNewlineIndent, finish };
}

function assertNoDocErrors(doc, text, lineCounter) {
  if (doc.errors?.length) {
    const first = doc.errors[0];
    const pos = Array.isArray(first.pos) && typeof first.pos[0] === 'number' ? first.pos[0] : 0;
    const isAliasLimit = first.code === 'ALIAS_OVERFLOW' || /alias/i.test(first.message);
    throw yamlError(
      text,
      lineCounter,
      pos,
      isAliasLimit ? 'YAML_ALIAS_LIMIT' : 'INVALID_YAML',
      first.message || 'Invalid YAML syntax',
    );
  }
}

function emitDocumentInto(doc, text, lineCounter, writer, startDepth, pretty) {
  if (!doc.contents) {
    writer.push('null');
    return;
  }

  let aliasExpansions = 0;
  const activeNodes = new Set();

  function resolveNode(node) {
    let current = node;
    while (current && isAlias(current)) {
      aliasExpansions++;
      if (aliasExpansions > MAX_ALIAS_EXPANSIONS) {
        throw yamlError(
          text,
          lineCounter,
          nodePosition(current),
          'YAML_ALIAS_LIMIT',
          `YAML alias expansion limit (${MAX_ALIAS_EXPANSIONS}) exceeded`,
        );
      }
      const target = current.resolve(doc);
      if (!target) {
        throw yamlError(text, lineCounter, nodePosition(current), 'INVALID_YAML', 'Unresolved YAML alias');
      }
      if (activeNodes.has(target)) {
        throw yamlError(text, lineCounter, nodePosition(current), 'YAML_ALIAS_LIMIT', 'Circular YAML alias is not supported in JSON');
      }
      current = target;
    }
    return current;
  }

  function validateTag(node) {
    if (node?.tag && !ALLOWED_TAGS.has(node.tag)) {
      throw yamlError(text, lineCounter, nodePosition(node), 'YAML_UNSUPPORTED_TAG', `Unsupported YAML tag: ${node.tag}`);
    }
  }

  function emitScalarValue(node) {
    validateTag(node);
    const value = node.value;
    if (value === null || value === undefined) {
      writer.push('null');
      return;
    }
    if (typeof value === 'boolean') {
      writer.push(value ? 'true' : 'false');
      return;
    }
    if (typeof value === 'number') {
      writer.push(normalizeJsonNumberLiteral(rawNodeSlice(node, text), value, text, lineCounter, node));
      return;
    }
    if (typeof value === 'string') {
      writer.push(JSON.stringify(value));
      return;
    }
    throw yamlError(
      text,
      lineCounter,
      nodePosition(node),
      'YAML_UNSUPPORTED_TAG',
      'Unsupported YAML scalar value for JSON conversion',
    );
  }

  // Iterative stack: { node, isMap, items, index, depth }
  const stack = [];

  function enterNode(rawNode, depth) {
    const node = resolveNode(rawNode);
    if (!node) {
      writer.push('null');
      return;
    }
    validateTag(node);
    if (isScalar(node)) {
      emitScalarValue(node);
      return;
    }
    if (isMap(node)) {
      if (activeNodes.has(node)) {
        throw yamlError(text, lineCounter, nodePosition(node), 'YAML_ALIAS_LIMIT', 'Circular YAML alias is not supported in JSON');
      }
      if (node.items.length === 0) {
        writer.push('{}');
        return;
      }
      activeNodes.add(node);
      writer.push('{');
      stack.push({ node, isMap: true, items: node.items, index: 0, depth });
      return;
    }
    if (isSeq(node)) {
      if (activeNodes.has(node)) {
        throw yamlError(text, lineCounter, nodePosition(node), 'YAML_ALIAS_LIMIT', 'Circular YAML alias is not supported in JSON');
      }
      if (node.items.length === 0) {
        writer.push('[]');
        return;
      }
      activeNodes.add(node);
      writer.push('[');
      stack.push({ node, isMap: false, items: node.items, index: 0, depth });
      return;
    }
    throw yamlError(text, lineCounter, nodePosition(node), 'INVALID_YAML', 'Unsupported YAML node type');
  }

  enterNode(doc.contents, startDepth);

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.items.length) {
      if (pretty) writer.pushNewlineIndent(frame.depth);
      writer.push(frame.isMap ? '}' : ']');
      activeNodes.delete(frame.node);
      stack.pop();
      continue;
    }
    const idx = frame.index++;
    if (idx > 0) writer.push(',');
    if (pretty) writer.pushNewlineIndent(frame.depth + 1);

    if (frame.isMap) {
      const pair = frame.items[idx];
      if (!isPair(pair)) {
        throw yamlError(text, lineCounter, nodePosition(pair), 'INVALID_YAML', 'Invalid YAML mapping pair');
      }
      const keyNode = resolveNode(pair.key);
      if (!keyNode) {
        writer.push(pretty ? '"null": ' : '"null":');
      } else if (!isScalar(keyNode)) {
        throw yamlError(
          text,
          lineCounter,
          nodePosition(keyNode),
          'YAML_COMPLEX_KEY',
          'Complex YAML keys (objects or arrays) cannot be represented in JSON',
        );
      } else {
        writer.push(JSON.stringify(scalarKeyString(keyNode, text, lineCounter)));
        writer.push(pretty ? ': ' : ':');
      }
      enterNode(pair.value, frame.depth + 1);
    } else {
      enterNode(frame.items[idx], frame.depth + 1);
    }
  }
}

/**
 * Parse YAML (core schema) and convert to JSON preserving exact number literals.
 * Multiple documents are wrapped into a JSON array with `multiDocument: true`.
 */
export function yamlToJson(text, { indent = '2', maxInputBytes = YAML_MAX_INPUT_BYTES } = {}) {
  if (
    typeof text === 'string'
    && (text.length > maxInputBytes || (text.length > Math.floor(maxInputBytes / 3) && utf8ByteLength(text) > maxInputBytes))
  ) {
    throw yamlError(text, null, 0, 'YAML_INPUT_TOO_LARGE', 'YAML input exceeds the maximum supported size');
  }

  const lineCounter = new LineCounter();
  const docs = parseAllDocuments(text, {
    schema: 'core',
    maxAliasCount: MAX_ALIAS_EXPANSIONS,
    lineCounter,
    keepSourceTokens: false,
    uniqueKeys: true,
  });

  if (docs.length === 0) {
    return { text: 'null', multiDocument: false, documentCount: 0 };
  }

  for (const doc of docs) {
    assertNoDocErrors(doc, text, lineCounter);
  }

  const indentUnit = normalizeJsonIndent(indent);
  const pretty = indentUnit !== null;
  const writer = createChunkedWriter(indentUnit);
  const multiDocument = docs.length > 1;

  if (!multiDocument) {
    emitDocumentInto(docs[0], text, lineCounter, writer, 0, pretty);
  } else {
    writer.push('[');
    for (let i = 0; i < docs.length; i++) {
      if (i > 0) writer.push(',');
      if (pretty) writer.pushNewlineIndent(1);
      emitDocumentInto(docs[i], text, lineCounter, writer, 1, pretty);
    }
    if (pretty) writer.pushNewlineIndent(0);
    writer.push(']');
  }

  return {
    text: writer.finish(),
    multiDocument,
    documentCount: docs.length,
  };
}
