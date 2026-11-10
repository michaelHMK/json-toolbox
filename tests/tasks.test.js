import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskHandler } from '../src/worker/tasks.js';

function run(action, text, options = {}, handler = createTaskHandler()) {
  const response = handler({ id: 7, action, text, ...options });
  assert.equal(response.id, 7);
  assert.equal(response.ok, true, response.error);
  assert.ok(response.duration >= 0);
  return response.result;
}

test('format/minify preserve number spelling, precision and escaped paths', () => {
  const text = '{"a/b":{"~":[9007199254740993,1.2300,1e400,-0]},"exp":1E+02}';
  const formatted = run('format', text);
  assert.equal(formatted.text, '{\n  "a/b": {\n    "~": [\n      9007199254740993,\n      1.2300,\n      1e400,\n      -0\n    ]\n  },\n  "exp": 1E+02\n}');
  assert.equal(formatted.numberLiterals['/a~1b/~0/0'], '9007199254740993');
  assert.equal(formatted.numberLiterals['/a~1b/~0/2'], '1e400');
  assert.equal(run('minify', formatted.text).text, text);
});

test('fallback keeps native key ordering, duplicate-key semantics and normalized strings', () => {
  const text = '{"2":2.00,"1":1.00,"x":{"old":1e9},"x":3,"s":"\\u4e2d\\/","__proto__":4.00}';
  const expected = '{"1":1.00,"2":2.00,"x":3,"s":"中/","__proto__":4.00}';
  assert.equal(run('minify', text).text, expected);
  const parsed = run('parse', text);
  assert.equal(parsed.numberLiterals['/x/old'], undefined);
  assert.equal(parsed.data.__proto__, 4);
  assert.equal(parsed.numberLiterals['/__proto__'], '4.00');
});

test('cache retention does not change formatting semantics', () => {
  const text = '{"a/b":{"~":[9007199254740993,1.2300,1e400,-0]},"exp":1E+02}';
  for (const indent of ['2', '4', 'tab']) {
    const preferred = run('format', text, { indent, includeData: false, retainSnapshot: false, retainSearch: false });
    assert.equal(preferred.text, run('format', text, { indent }).text);
    assert.equal(preferred.snapshotId, undefined);
  }
  assert.equal(run('minify', text, { retainSearch: false }).text, run('minify', text).text);
});

test('large text-only formatting handles deep JSON without a recursive stack', () => {
  const depth = 10000;
  const source = '['.repeat(depth) + '0' + ']'.repeat(depth);
  const handler = createTaskHandler();
  const formatted = run('format', ' '.repeat(2 * 1024 * 1024) + source, {
    indent: 'tab', includeData: false, retainSnapshot: false, retainSearch: false,
  }, handler);
  assert.deepEqual(Object.keys(formatted), ['text']);
  assert.equal(formatted.text.length, depth * depth + 4 * depth + 1);
  let value = JSON.parse(formatted.text);
  for (let i = 0; i < depth; i++) {
    assert.equal(value.length, 1);
    value = value[0];
  }
  assert.equal(value, 0);
  assert.equal(handler({ action: 'search', text: '0' }).ok, false);
});

test('deep serialization normalizes keys and strings while preserving number literals', () => {
  const depth = 10000;
  const source = '['.repeat(depth) +
    '{"2":2.00,"1":1e400,"x":{"old":3.00},"x":-0,"a/b":{"~":9007199254740993},"s":"\\u4e2d\\/","__proto__":4.00}' +
    ']'.repeat(depth);
  const expected = '['.repeat(depth) +
    '{"1":1e400,"2":2.00,"x":-0,"a/b":{"~":9007199254740993},"s":"中/","__proto__":4.00}' +
    ']'.repeat(depth);
  assert.equal(run('minify', source, { retainSearch: false }).text, expected);
});

test('large numeric documents preserve every literal and lazily populate retained snapshots', () => {
  const tokens = Array.from({ length: 1200 }, (_, i) => ['1.20', '9007199254740993', '1e400', '-0'][i % 4]);
  const compact = '[' + tokens.join(',') + ']';
  const source = ' '.repeat(2 * 1024 * 1024) + compact;
  assert.equal(run('minify', source, { retainSearch: false }).text, compact);
  const handler = createTaskHandler();
  const formatted = run('format', source, { includeData: false, retainSnapshot: true }, handler);
  assert.equal(formatted.text, '[\n  ' + tokens.join(',\n  ') + '\n]');
  const parsed = run('parseSnapshot', undefined, { snapshotId: formatted.snapshotId }, handler);
  assert.equal(Object.keys(parsed.numberLiterals).length, tokens.length);
  for (let i = 0; i < tokens.length; i++) assert.equal(parsed.numberLiterals['/' + i], tokens[i]);
  const repeated = run('format', source, { retainSnapshot: true }, handler);
  assert.equal(repeated.text, formatted.text);
  assert.strictEqual(repeated.numberLiterals, parsed.numberLiterals);
});

test('large numeric documents still normalize strings and discard overwritten literals', () => {
  const numbers = Array(1200).fill('1.20').join(',');
  const source = ' '.repeat(2 * 1024 * 1024) +
    '{"x":[' + numbers + '],"x":null,"2":2.00,"1":1e400,"a/b":{"~":[' + numbers + ']},"s":"\\u4e2d\\/"}';
  const expected = '{"1":1e400,"2":2.00,"x":null,"a/b":{"~":[' + numbers + ']},"s":"中/"}';
  assert.equal(run('minify', source, { retainSearch: false }).text, expected);
  const parsed = run('format', source);
  assert.equal(parsed.numberLiterals['/x/0'], undefined);
  assert.equal(parsed.numberLiterals['/a~1b/~0/1199'], '1.20');
  assert.equal(parsed.numberLiterals['/1'], '1e400');
});

for (const [indent, unit] of [['2', '  '], ['4', '    '], ['tab', '\t']]) {
  test(`format supports ${indent} indentation`, () => {
    assert.equal(run('format', '{"nested":[true,null]}', { indent }).text,
      `{\n${unit}"nested": [\n${unit}${unit}true,\n${unit}${unit}null\n${unit}]\n}`);
  });
}

test('format handles primitive roots and empty containers', () => {
  for (const text of ['null', 'true', '"text"', '[]', '{}', '-0', '1.00']) {
    assert.equal(run('format', text).text, text);
  }
});

test('search cache belongs to each session and survives omitted data and invalid input', () => {
  const handler = createTaskHandler();
  const other = createTaskHandler();
  assert.equal(other({ action: 'search', text: 'needle' }).ok, false);
  const formatted = run('format', '{"a/b":{"~":"Needle"}}', { includeData: false }, handler);
  assert.deepEqual(Object.keys(formatted), ['text']);
  assert.equal(handler({ action: 'parse', text: '{' }).ok, false);
  assert.deepEqual(run('search', 'needle', {}, handler), {
    highlights: ['/a~1b/~0'], forceExpand: ['', '/a~1b'], matchCount: 1, truncated: false,
  });
  assert.equal(other({ action: 'search', text: 'needle' }).ok, false);
  run('minify', '["replacement"]', {}, handler);
  assert.equal(run('search', 'needle', {}, handler).matchCount, 0);
  run('parse', 'null', {}, handler);
  assert.deepEqual(run('search', 'null', {}, handler).highlights, ['']);
});

test('search ignores array indexes and caps details while counting every match', () => {
  const handler = createTaskHandler();
  run('parse', JSON.stringify(Array(600).fill('needle')), {}, handler);
  const result = run('search', 'needle', {}, handler);
  assert.equal(result.matchCount, 600);
  assert.equal(result.highlights.length, 500);
  assert.equal(result.truncated, true);
  assert.equal(run('search', '0', {}, handler).matchCount, 0);
});

test('clear releases worker search data and leaves the session reusable', () => {
  const handler = createTaskHandler();
  run('parse', '{"value":"needle"}', {}, handler);
  run('clear', undefined, {}, handler);
  assert.equal(handler({ action: 'search', text: 'needle' }).ok, false);
  run('format', '["next"]', {}, handler);
  assert.equal(run('search', 'next', {}, handler).matchCount, 1);
});

test('a text-only minify caller can release parsed data instead of retaining a search cache', () => {
  const handler = createTaskHandler();
  run('parse', '{"old":"needle"}', {}, handler);
  assert.equal(run('minify', '{"next":1.00}', { retainSearch: false }, handler).text, '{"next":1.00}');
  assert.equal(handler({ action: 'search', text: 'next' }).ok, false);
  run('minify', '{"next":1}', {}, handler);
  assert.equal(run('search', 'next', {}, handler).matchCount, 1);
});

test('escape/unescape round-trip quotes, control characters and Unicode', () => {
  const text = '中😀\n\t\r\u0000"\\/\u2028';
  assert.equal(run('unescape', run('escape', text).text).text, text);
  assert.equal(run('unescape', 'raw\nline\tend').text, 'raw\nline\tend');
});

test('task errors preserve ids, error locations and unknown-action failure', () => {
  const handler = createTaskHandler();
  const error = handler({ id: 42, action: 'parse', text: '{\n  a:1}' });
  assert.equal(error.id, 42);
  assert.equal(error.ok, false);
  assert.match(error.error, /JSON/);
  assert.equal(error.position, 4);
  assert.equal(error.line, 2);
  assert.equal(error.column, 3);
  assert.equal(handler({ action: 'unknown' }).ok, false);
  assert.equal(handler({ action: 'unescape', text: '\\x' }).ok, false);
});

test('structural diff keeps escaped paths, previews and all change categories', () => {
  const result = run('diff', '{"a/b":1.00,"gone":true,"type":{},"stable":0}', {
    text2: '{"a/b":2.00,"new":null,"type":[],"stable":0}',
  });
  assert.deepEqual(result.stats, { added: 1, removed: 1, changed: 1, typeChanged: 1 });
  assert.equal(result.total, 4);
  const changed = result.diffs.find((diff) => diff.type === 'changed');
  assert.equal(changed.leftPath, '/a~1b');
  assert.equal(changed.leftPreview, '1.00');
  assert.equal(changed.rightPreview, '2.00');
});

test('keyed arrays support reordering, ignored fields and index fallback', () => {
  const left = '{"list":[{"id":1,"updated":1},{"id":2,"updated":2}]}';
  const right = '{"list":[{"id":2,"updated":3},{"id":1,"updated":4}]}';
  const result = run('diff', left, { text2: right, keyField: 'id', ignorePaths: ['list[*].updated'] });
  assert.equal(result.total, 0);
  assert.deepEqual(result.pairs, [['/list/0', '/list/1'], ['/list/1', '/list/0']]);
  assert.equal(result.keyFallback, false);
  const fallback = run('diff', '[1,2]', { text2: '[1,3]', keyField: 'id' });
  assert.equal(fallback.keyFallback, true);
  assert.equal(fallback.total, 1);
});

test('structural diff caps details without losing total counts', () => {
  const result = run('diff', JSON.stringify(Array(5001).fill(0)), {
    text2: JSON.stringify(Array(5001).fill(1)),
  });
  assert.equal(result.total, 5001);
  assert.equal(result.diffs.length, 5000);
  assert.equal(result.truncated, true);
});

test('diff reports which input is invalid', () => {
  const handler = createTaskHandler();
  assert.match(handler({ action: 'diff', text: '{', text2: '{}' }).error, /^左侧/);
  assert.match(handler({ action: 'diff', text: '{}', text2: '{' }).error, /^右侧/);
});

function assertTextDiffReconstructs(result) {
  const a = result.aText.split('\n');
  const b = result.bText.split('\n');
  const reconstructedA = [];
  const reconstructedB = [];
  for (const op of result.ops) {
    if (op.type !== 'add') reconstructedA.push(...a.slice(op.aStart, op.aStart + op.count));
    if (op.type !== 'del') reconstructedB.push(...b.slice(op.bStart, op.bStart + op.count));
    if (op.type === 'same') {
      assert.deepEqual(a.slice(op.aStart, op.aStart + op.count), b.slice(op.bStart, op.bStart + op.count));
    }
  }
  assert.deepEqual(reconstructedA, a);
  assert.deepEqual(reconstructedB, b);
}

test('text diff preserves literals and reconstructs equal and changed inputs', () => {
  for (const [left, right] of [
    ['{"x":1.00}', '{"x":2.00}'],
    ['[1,2,3]', '[1,4,3,5]'],
    ['{}', '{}'],
    ['{"x":1}', ' { "x" : 1 } '],
  ]) {
    const result = run('textDiff', left, { text2: right, indent: '2' });
    assert.equal(result.blocky, false);
    assertTextDiffReconstructs(result);
  }
});

test('large text diff uses bounded block replacement', () => {
  const result = run('textDiff', JSON.stringify(Array(1600).fill(1)), {
    text2: JSON.stringify(Array(1600).fill(2)),
  });
  assert.equal(result.blocky, true);
  assertTextDiffReconstructs(result);
});
