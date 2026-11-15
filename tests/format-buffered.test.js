import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collectNumberLiterals, formatJson, parseJsonPreservingNumberLiterals } from '../src/core/json.js';
import { appendJsonPath } from '../src/core/json-path.js';

// Deliberately independent, allocation-heavy reference for small test documents.
// JSON.parse/Object.keys/JSON.stringify provide native duplicate/order/escape rules.
function reference(text, indent) {
  const data = JSON.parse(text);
  const literals = collectNumberLiterals(text);
  const unit = indent === null ? '' : indent === 'tab' ? '\t' : ' '.repeat(Number(indent));
  function visit(value, path, depth) {
    if (value === null || typeof value !== 'object') return literals[path] ?? JSON.stringify(value);
    const array = Array.isArray(value);
    const keys = Object.keys(value);
    const open = array ? '[' : '{';
    const close = array ? ']' : '}';
    if (!keys.length) return open + close;
    const members = keys.map((key) => (array ? '' : JSON.stringify(key) + (unit ? ': ' : ':')) + visit(value[key], appendJsonPath(path, key), depth + 1));
    return unit ? open + '\n' + unit.repeat(depth + 1) + members.join(',\n' + unit.repeat(depth + 1)) + '\n' + unit.repeat(depth) + close
      : open + members.join(',') + close;
  }
  return { text: visit(data, '', 0), literals };
}

function assertMatchesReference(text) {
  for (const indent of [null, '2', '4', 'tab', '10']) {
    const expected = reference(text, indent);
    for (const includeNumberLiterals of [false, true]) {
      const actual = formatJson(text, { indent, includeNumberLiterals });
      assert.equal(actual.text, expected.text, `${indent}: ${text.slice(0, 100)}`);
      if (includeNumberLiterals) assert.deepEqual(actual.numberLiterals, expected.literals);
    }
    const parsed = parseJsonPreservingNumberLiterals(text);
    assert.equal(formatJson(text, { indent, parsed, includeNumberLiterals: true }).text, expected.text);
  }
}

test('buffered formatting agrees with native semantics and exact numeric tokens', () => {
  const keys = Array.from({ length: 24 }, (_, i) => `"field${i}":${i}.00`).join(',');
  for (const text of [
    '1e400', '-0', '-1e-400', 'null', 'true', 'false', '[]', '{}',
    '[1.20,1e3,9007199254740993,{"a/b":{"~":[1.0,{},[],2.00]}}]',
    '{"中文":"汉字，标点！","\ufeff":"\ufeff","a/b":1.20,"~":2.0}',
    '{"a\\nb":1.00,"a\\tb":2.0,"a\\\"b":3.0,"a\\\\b":4.0}',
    '{"controls":"\\b\\f\\n\\r\\t\\\"\\\\"}',
    '{' + keys + '}',
    '{' + keys + ',"field0":8.0}',
    '{"ab":1.0,"cd":2.0,"ab":3.0}',
    '{"a\\nb":1.0,"a\\nb":2}',
    '{"z":1.0,"2":2.00,"10":10.0,"01":3.0,"1":1e0}',
    '{"key\\u0061":1.0,"keya":2.0,"slash":"\\/"}',
    '{"emoji":"😀","lone":"\ud800","escaped":"\\ud800","number":1.20}',
    '{"outer":{"old":[1.0,2.0]},"outer":{"new":3.0},"after":4.0}',
    '{"nested":[{"a":1.0},{"b":{"c":2.0}},[3.0,4.0],5.0],"last":6.0}',
  ]) assertMatchesReference(text);
});

test('deterministic mixed documents agree with the reference across indent modes', () => {
  let state = 0x8c7f21;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  const numbers = ['1', '0', '-0', '12.340', '1e400', '9007199254740993', '1e-400'];
  const strings = ['"ascii"', '"中文"', '"a\\nb"', '"\\u0061"', '"😀"'];
  function build(depth) {
    const kind = random() % (depth ? 7 : 5);
    if (kind < 3) return numbers[random() % numbers.length];
    if (kind === 3) return strings[random() % strings.length];
    if (kind === 4) return ['true', 'false', 'null'][random() % 3];
    const items = Array.from({ length: random() % 7 }, () => build(depth - 1));
    if (kind === 5) return '[' + items.join(', \n') + ']';
    return '{' + items.map((item) => JSON.stringify(['a/b', '~', 'same', '2', '中文', 'line\nkey'][random() % 6]) + ':' + item).join(',') + '}';
  }
  for (let i = 0; i < 80; i++) assertMatchesReference(build(4));
});

test('ASCII and wide buffers grow without changing output or literal paths', () => {
  for (const leaf of ['1.20', '"中文"']) {
    const text = '[' + Array(24_000).fill('[[[' + leaf + ']]]').join(',') + ']';
    const actual = formatJson(text, { indent: '4', includeNumberLiterals: true });
    const expected = reference(text, '4');
    assert.equal(actual.text, expected.text);
    assert.deepEqual(actual.numberLiterals, expected.literals);
  }
});

test('invalid source is rejected before direct formatting can accept a token', () => {
  for (const text of ['[1,]', '{"a":01}', '"\\x"', '[true false]', '{"a":1,"b":}']) {
    assert.throws(() => formatJson(text), SyntaxError);
  }
});

// Exercise the real formatter at a reduced VM ceiling instead of allocating
// half a gigabyte merely to reach Chrome's string-length boundary.
test('buffer growth rejects output beyond the string ceiling with a recoverable error', () => {
  const source = readFileSync(new URL('../src/core/json.js', import.meta.url), 'utf8');
  assert.ok(source.includes('const MAX_OUTPUT_LENGTH = 0x1fffffe8;'));
  const boundedSource = source.replace("import { appendJsonPath } from './json-path.js';", '')
    .replace('const MAX_OUTPUT_LENGTH = 0x1fffffe8;', 'const MAX_OUTPUT_LENGTH = 256;')
    .replaceAll('export function ', 'function ');
  const boundedFormat = new Function('appendJsonPath', boundedSource + '; return formatJson;')(appendJsonPath);
  for (const leaf of ['0', '"中文"']) {
    const source = '['.repeat(16) + leaf + ']'.repeat(16);
    assert.throws(() => boundedFormat(source), /maximum string length/);
    assert.equal(boundedFormat(source, { indent: null }).text, source);
    assert.equal(boundedFormat('[1.20]', { indent: null }).text, '[1.20]');
  }
});
