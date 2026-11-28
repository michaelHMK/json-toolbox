import { LineCounter, isAlias, isMap, isPair, isScalar, isSeq, parseAllDocuments } from '../vendor/yaml.js';
import { formatJson } from './json.js';
import { errorLocationAtPosition } from './parse-error.js';

const MAX_ALIAS_EXPANSIONS = 100;
const ALLOWED_TAGS = new Set([
  'tag:yaml.org,2002:str',
  'tag:yaml.org,2002:int',
  'tag:yaml.org,2002:float',
  'tag:yaml.org,2002:bool',
  'tag:yaml.org,2002:null',
  'tag:yaml.org,2002:map',
  'tag:yaml.org,2002:seq',
]);

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

function normalizeJsonNumberLiteral(raw, value, text, lineCounter, node) {
  const token = raw.trim();
  if (!Number.isFinite(value) || Number.isNaN(value)) {
    if (!token || /^[+-]?\.(?:inf|infinity|nan)$/i.test(token)) {
      throw yamlError(
        text,
        lineCounter,
        nodePosition(node),
        'YAML_NON_FINITE',
        'Non-finite number (Infinity/NaN) is not valid in JSON',
      );
    }
    return token.charCodeAt(0) === 43 ? token.slice(1) : token;
  }

  if (node.type !== 'PLAIN' || !token) {
    return Object.is(value, -0) ? '-0' : String(value);
  }

  // Strip YAML underscores in numeric literals if any, and leading '+'.
  let s = token.charCodeAt(0) === 43 ? token.slice(1) : token;
  const neg = s.charCodeAt(0) === 45;
  const unsigned = neg ? s.slice(1) : s;

  if (/^0[xX][0-9a-fA-F]+$/.test(unsigned)) {
    const mag = BigInt(unsigned);
    if (mag === 0n) return neg ? '-0' : '0';
    return (neg ? '-' : '') + mag.toString(10);
  }
  if (/^0[oO][0-7]+$/.test(unsigned)) {
    const mag = BigInt(unsigned);
    if (mag === 0n) return neg ? '-0' : '0';
    return (neg ? '-' : '') + mag.toString(10);
  }

  // Handle leading dot (.5) or trailing dot (5.) or leading zeros (0123).
  if (unsigned.startsWith('.')) {
    return (neg ? '-' : '') + '0' + unsigned;
  }

  const match = /^([0-9]+)(?:\.([0-9]*))?([eE][+-]?[0-9]+)?$/.exec(unsigned);
  if (!match) {
    return Object.is(value, -0) ? '-0' : String(value);
  }
  let [, intPart, fracPart, expPart = ''] = match;
  // JSON forbids leading zeros on integers (e.g. 0123 -> 123, 00 -> 0).
  if (intPart.length > 1 && intPart.charCodeAt(0) === 48) {
    intPart = intPart.replace(/^0+/, '') || '0';
  }
  if (fracPart !== undefined && fracPart.length > 0) {
    return (neg ? '-' : '') + intPart + '.' + fracPart + expPart;
  }
  return (neg ? '-' : '') + intPart + expPart;
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
    const raw = node.srcToken?.source ?? (node.range ? text.slice(node.range[0], node.range[1]) : '');
    return normalizeJsonNumberLiteral(raw, value, text, lineCounter, node);
  }
  return String(value);
}

function emitDocumentAsCompactJson(doc, text, lineCounter) {
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

  if (!doc.contents) return 'null';

  const chunks = [];
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
      chunks.push('null');
      return;
    }
    if (typeof value === 'boolean') {
      chunks.push(value ? 'true' : 'false');
      return;
    }
    if (typeof value === 'number') {
      const raw = node.srcToken?.source ?? (node.range ? text.slice(node.range[0], node.range[1]) : '');
      chunks.push(normalizeJsonNumberLiteral(raw, value, text, lineCounter, node));
      return;
    }
    if (typeof value === 'string') {
      chunks.push(JSON.stringify(value));
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

  // Iterative stack: { node, isMap, items, index }
  const stack = [];

  function enterNode(rawNode) {
    const node = resolveNode(rawNode);
    if (!node) {
      chunks.push('null');
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
        chunks.push('{}');
        return;
      }
      activeNodes.add(node);
      chunks.push('{');
      stack.push({ node, isMap: true, items: node.items, index: 0 });
      return;
    }
    if (isSeq(node)) {
      if (activeNodes.has(node)) {
        throw yamlError(text, lineCounter, nodePosition(node), 'YAML_ALIAS_LIMIT', 'Circular YAML alias is not supported in JSON');
      }
      if (node.items.length === 0) {
        chunks.push('[]');
        return;
      }
      activeNodes.add(node);
      chunks.push('[');
      stack.push({ node, isMap: false, items: node.items, index: 0 });
      return;
    }
    throw yamlError(text, lineCounter, nodePosition(node), 'INVALID_YAML', 'Unsupported YAML node type');
  }

  enterNode(doc.contents);

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.items.length) {
      chunks.push(frame.isMap ? '}' : ']');
      activeNodes.delete(frame.node);
      stack.pop();
      continue;
    }
    const idx = frame.index++;
    if (idx > 0) chunks.push(',');

    if (frame.isMap) {
      const pair = frame.items[idx];
      if (!isPair(pair)) {
        throw yamlError(text, lineCounter, nodePosition(pair), 'INVALID_YAML', 'Invalid YAML mapping pair');
      }
      const keyNode = resolveNode(pair.key);
      if (!keyNode) {
        chunks.push('"null":');
      } else if (!isScalar(keyNode)) {
        throw yamlError(
          text,
          lineCounter,
          nodePosition(keyNode),
          'YAML_COMPLEX_KEY',
          'Complex YAML keys (objects or arrays) cannot be represented in JSON',
        );
      } else {
        chunks.push(JSON.stringify(scalarKeyString(keyNode, text, lineCounter)), ':');
      }
      enterNode(pair.value);
    } else {
      enterNode(frame.items[idx]);
    }
  }

  return chunks.length === 1 ? chunks[0] : chunks.join('');
}

/**
 * Parse YAML (core schema) and convert to JSON preserving exact number literals.
 * Multiple documents are wrapped into a JSON array with `multiDocument: true`.
 */
export function yamlToJson(text, { indent = '2' } = {}) {
  const lineCounter = new LineCounter();
  const docs = parseAllDocuments(text, {
    schema: 'core',
    maxAliasCount: MAX_ALIAS_EXPANSIONS,
    lineCounter,
    keepSourceTokens: true,
    uniqueKeys: true,
  });

  if (docs.length === 0) {
    return { text: 'null', multiDocument: false, documentCount: 0 };
  }

  let compactJson;
  const multiDocument = docs.length > 1;
  if (!multiDocument) {
    compactJson = emitDocumentAsCompactJson(docs[0], text, lineCounter);
  } else {
    const docJsons = docs.map((doc) => emitDocumentAsCompactJson(doc, text, lineCounter));
    compactJson = '[' + docJsons.join(',') + ']';
  }

  const formatted = formatJson(compactJson, { indent, includeData: false });
  return {
    text: formatted.text,
    multiDocument,
    documentCount: docs.length,
  };
}
