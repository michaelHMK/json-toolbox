import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskHandler } from '../src/worker/tasks.js';

function run(handler, request) {
  const response = handler({ id: 42, ...request });
  assert.equal(response.id, 42);
  assert.equal(response.ok, true, response.error);
  assert.ok(response.duration >= 0);
  return response.result;
}

function rejects(handler, request, pattern = /snapshot.*available/i) {
  const response = handler({ id: 43, ...request });
  assert.equal(response.id, 43);
  assert.equal(response.ok, false);
  assert.match(response.error, pattern);
}

const numbers = '{"a/b":{"~":[9007199254740993,1.2300,1e400,-0]},"exp":1E+02}';
const reordered = '{"2":2.00,"1":1E+02,"x":{"old":1e9},"x":3.00,"s":"\\u4e2d\\/","__proto__":4.00}';

function assertNumberLiterals(parsed) {
  assert.deepEqual({ ...parsed.numberLiterals }, {
    '/a~1b/~0/0': '9007199254740993',
    '/a~1b/~0/1': '1.2300',
    '/a~1b/~0/2': '1e400',
    '/a~1b/~0/3': '-0',
    '/exp': '1E+02',
  });
  assert.equal(parsed.data['a/b']['~'][2], Infinity);
  assert.equal(Object.is(parsed.data['a/b']['~'][3], -0), true);
}

test('snapshot retention is opt-in and preserves legacy response shapes', () => {
  const handler = createTaskHandler();
  assert.deepEqual(Object.keys(run(handler, { action: 'format', text: '{}' })), ['text', 'data', 'numberLiterals']);
  assert.deepEqual(Object.keys(run(handler, { action: 'format', text: '{}', includeData: false })), ['text']);
  assert.deepEqual(Object.keys(run(handler, { action: 'parse', text: '{}' })), ['data', 'numberLiterals']);
  assert.deepEqual(Object.keys(run(handler, { action: 'minify', text: '{}' })), ['text']);
  const diff = run(handler, { action: 'diff', text: '{}', text2: '{"value":1}' });
  assert.equal(Object.hasOwn(diff, 'snapshotId'), false);
  assert.deepEqual(diff.leftData, {});
  assert.deepEqual(diff.rightData, { value: 1 });
  const textDiff = run(handler, { action: 'textDiff', text: '{}', text2: '{}' });
  assert.deepEqual(Object.keys(textDiff).sort(), ['aText', 'bText', 'blocky', 'ops', 'totalLines']);
  rejects(handler, { action: 'parseSnapshot', snapshotId: 1 });
  rejects(handler, { action: 'comparisonData', snapshotId: 1 });
});

test('format snapshots lazily return original literals without retransmitting source or data', () => {
  const handler = createTaskHandler();
  const formatted = run(handler, {
    action: 'format', text: numbers, includeData: false, retainSnapshot: true,
  });
  assert.deepEqual(Object.keys(formatted), ['text', 'snapshotId']);
  const parsed = run(handler, { action: 'parseSnapshot', snapshotId: formatted.snapshotId });
  assertNumberLiterals(parsed);
  const repeated = run(handler, { action: 'parseSnapshot', snapshotId: formatted.snapshotId });
  assert.strictEqual(repeated.data, parsed.data);
  assert.strictEqual(repeated.numberLiterals, parsed.numberLiterals);
  const reformatted = run(handler, { action: 'format', text: numbers, indent: '4', retainSnapshot: true });
  assert.strictEqual(reformatted.data, parsed.data);
  assert.strictEqual(reformatted.numberLiterals, parsed.numberLiterals);
  assert.match(reformatted.text, /\n    "a\/b":/);
  assert.notEqual(reformatted.snapshotId, formatted.snapshotId);
  rejects(handler, { action: 'parseSnapshot', snapshotId: formatted.snapshotId });
});

test('cached format and parse preserve key reordering, duplicate keys and normalized strings', () => {
  const handler = createTaskHandler();
  const formatted = run(handler, { action: 'format', text: reordered, retainSnapshot: true });
  assert.deepEqual(Object.keys(formatted.data), ['1', '2', 'x', 's', '__proto__']);
  assert.equal(formatted.data.x, 3);
  assert.equal(formatted.data.s, '中/');
  assert.equal(formatted.data.__proto__, 4);
  assert.equal(formatted.numberLiterals['/x/old'], undefined);
  assert.equal(formatted.numberLiterals['/x'], '3.00');
  assert.equal(formatted.numberLiterals['/1'], '1E+02');
  assert.equal(formatted.numberLiterals['/__proto__'], '4.00');
  for (const text of [reordered, formatted.text]) {
    const parsed = run(handler, { action: 'parse', text, retainSnapshot: true });
    assert.strictEqual(parsed.data, formatted.data);
    assert.strictEqual(parsed.numberLiterals, formatted.numberLiterals);
    assert.equal(parsed.snapshotId, formatted.snapshotId);
  }
  const tabbed = run(handler, { action: 'format', text: reordered, indent: 'tab', retainSnapshot: true });
  assert.strictEqual(tabbed.data, formatted.data);
  assert.match(tabbed.text, /^\{\n\t"1": 1E\+02,/);
  assert.equal(tabbed.text.includes('old'), false);
});

test('parse snapshots reuse parsed data for repeated parsing and subsequent formatting', () => {
  const handler = createTaskHandler();
  const first = run(handler, { action: 'parse', text: numbers, retainSnapshot: true });
  const second = run(handler, { action: 'parse', text: numbers, retainSnapshot: true });
  const formatted = run(handler, { action: 'format', text: numbers, retainSnapshot: true });
  assert.strictEqual(second.data, first.data);
  assert.strictEqual(formatted.data, first.data);
  assert.strictEqual(formatted.numberLiterals, first.numberLiterals);
  assertNumberLiterals(formatted);
});

test('comparison summaries omit trees and recover their exact literals by snapshot id', () => {
  const handler = createTaskHandler();
  const right = numbers.replace('1.2300', '2.3400');
  const summary = run(handler, {
    action: 'diff', text: numbers, text2: right, includeData: false, retainSnapshot: true,
  });
  for (const key of ['leftData', 'rightData', 'leftNumberLiterals', 'rightNumberLiterals']) {
    assert.equal(Object.hasOwn(summary, key), false);
  }
  assert.equal(summary.total, 1);
  assert.equal(summary.diffs[0].leftPreview, '1.2300');
  assert.equal(summary.diffs[0].rightPreview, '2.3400');
  const data = run(handler, { action: 'comparisonData', snapshotId: summary.snapshotId });
  assertNumberLiterals({ data: data.leftData, numberLiterals: data.leftNumberLiterals });
  assert.equal(data.rightNumberLiterals['/a~1b/~0/1'], '2.3400');
  const repeated = run(handler, { action: 'comparisonData', snapshotId: summary.snapshotId });
  assert.strictEqual(repeated.leftData, data.leftData);
  assert.strictEqual(repeated.rightData, data.rightData);
});

test('repeated and swapped comparisons reuse both parsed sides while recomputing options', () => {
  const handler = createTaskHandler();
  const left = '{"rows":[{"id":1,"value":1.00},{"id":2,"value":2.00}]}';
  const right = '{"rows":[{"id":2,"value":3.00},{"id":1,"value":4.00}]}';
  const initial = run(handler, { action: 'diff', text: left, text2: right, retainSnapshot: true });
  const keyed = run(handler, {
    action: 'diff', text: left, text2: right, keyField: 'id',
    ignorePaths: ['rows[*].value'], retainSnapshot: true,
  });
  assert.strictEqual(keyed.leftData, initial.leftData);
  assert.strictEqual(keyed.rightData, initial.rightData);
  assert.strictEqual(keyed.leftNumberLiterals, initial.leftNumberLiterals);
  assert.equal(keyed.total, 0);
  assert.deepEqual(keyed.pairs, [['/rows/0', '/rows/1'], ['/rows/1', '/rows/0']]);
  const swapped = run(handler, { action: 'diff', text: right, text2: left, retainSnapshot: true });
  assert.strictEqual(swapped.leftData, initial.rightData);
  assert.strictEqual(swapped.rightData, initial.leftData);
  assert.strictEqual(swapped.leftNumberLiterals, initial.rightNumberLiterals);
  assert.strictEqual(swapped.rightNumberLiterals, initial.leftNumberLiterals);
  assert.equal(swapped.total, initial.total);
  rejects(handler, { action: 'comparisonData', snapshotId: keyed.snapshotId });
});

test('replacing just one comparison side retains the other parsed object', () => {
  const handler = createTaskHandler();
  const original = run(handler, { action: 'diff', text: reordered, text2: numbers, retainSnapshot: true });
  const changed = run(handler, { action: 'diff', text: reordered, text2: '{"new":true}', retainSnapshot: true });
  assert.strictEqual(changed.leftData, original.leftData);
  assert.strictEqual(changed.leftNumberLiterals, original.leftNumberLiterals);
  assert.notStrictEqual(changed.rightData, original.rightData);
  assert.equal(changed.leftData.x, 3);
  assert.equal(changed.leftNumberLiterals['/x/old'], undefined);
});

test('view-only text diff needs only snapshot id and invalidates its result on indentation changes', () => {
  const handler = createTaskHandler();
  const right = reordered.replace('3.00', '5.00');
  const compared = run(handler, {
    action: 'diff', text: reordered, text2: right, includeData: false, retainSnapshot: true,
  });
  const snapshotId = compared.snapshotId;
  const twoSpaces = run(handler, { action: 'textDiff', snapshotId, indent: '2' });
  assert.strictEqual(run(handler, { action: 'textDiff', snapshotId, indent: '2' }), twoSpaces);
  assert.deepEqual(twoSpaces, run(createTaskHandler(), { action: 'textDiff', text: reordered, text2: right, indent: '2' }));
  assert.match(twoSpaces.aText, /"1": 1E\+02/);
  assert.match(twoSpaces.aText, /"x": 3\.00/);
  assert.match(twoSpaces.bText, /"x": 5\.00/);
  for (const indent of ['4', 'tab', '2', undefined]) {
    const result = run(handler, { action: 'textDiff', snapshotId, indent });
    const expected = run(createTaskHandler(), { action: 'textDiff', text: reordered, text2: right, indent });
    assert.deepEqual(result, expected);
    assert.strictEqual(run(handler, { action: 'textDiff', snapshotId, indent }), result);
  }
});

test('identical comparison inputs share one parsed object and yield one unchanged text range', () => {
  const handler = createTaskHandler();
  const compared = run(handler, { action: 'diff', text: numbers, text2: numbers, retainSnapshot: true });
  assert.strictEqual(compared.leftData, compared.rightData);
  assert.strictEqual(compared.leftNumberLiterals, compared.rightNumberLiterals);
  const result = run(handler, { action: 'textDiff', snapshotId: compared.snapshotId });
  assert.equal(result.aText, result.bText);
  assert.equal(result.ops.length, 1);
  assert.equal(result.ops[0].type, 'same');
});

test('invalid and missing input never overwrite successful document or comparison snapshots', () => {
  const handler = createTaskHandler();
  const document = run(handler, { action: 'parse', text: '{"keep":"needle"}', retainSnapshot: true });
  const compared = run(handler, { action: 'diff', text: numbers, text2: reordered, retainSnapshot: true });
  for (const request of [
    { action: 'parse' },
    { action: 'parse', text: '{', retainSnapshot: true },
    { action: 'format', text: '{', retainSnapshot: true },
    { action: 'minify', text: '{' },
    { action: 'diff', text: '{', text2: reordered, retainSnapshot: true },
    { action: 'diff', text: '{}', text2: '{', retainSnapshot: true },
    { action: 'textDiff', text: '{}', text2: '{' },
  ]) {
    rejects(handler, request, /JSON/);
    assert.strictEqual(run(handler, { action: 'parseSnapshot', snapshotId: document.snapshotId }).data, document.data);
    const recovered = run(handler, { action: 'comparisonData', snapshotId: compared.snapshotId });
    assert.strictEqual(recovered.leftData, compared.leftData);
    assert.strictEqual(recovered.rightData, compared.rightData);
    assert.equal(run(handler, { action: 'search', text: 'needle' }).matchCount, 1);
  }
  for (const [request, side] of [
    [{ action: 'diff', text2: '{}' }, 'left'],
    [{ action: 'diff', text: '{}' }, 'right'],
  ]) {
    const response = createTaskHandler()(request);
    assert.equal(response.ok, false);
    assert.equal(response.code, 'INVALID_JSON');
    assert.equal(response.side, side);
  }
});

test('replacing and clearing snapshots rejects stale ids without reusing them', () => {
  const handler = createTaskHandler();
  const oldDocument = run(handler, { action: 'parse', text: numbers, retainSnapshot: true });
  const oldComparison = run(handler, { action: 'diff', text: numbers, text2: reordered, retainSnapshot: true });
  const nextDocument = run(handler, { action: 'parse', text: '{"replacement":true}', retainSnapshot: true });
  const nextComparison = run(handler, { action: 'diff', text: '[]', text2: '{}', retainSnapshot: true });
  rejects(handler, { action: 'parseSnapshot', snapshotId: oldDocument.snapshotId });
  rejects(handler, { action: 'comparisonData', snapshotId: oldComparison.snapshotId });
  rejects(handler, { action: 'textDiff', snapshotId: oldComparison.snapshotId });
  rejects(handler, { action: 'parseSnapshot', snapshotId: nextComparison.snapshotId });
  rejects(handler, { action: 'comparisonData', snapshotId: nextDocument.snapshotId });
  assert.deepEqual(run(handler, { action: 'clear' }), {});
  rejects(handler, { action: 'parseSnapshot', snapshotId: nextDocument.snapshotId });
  rejects(handler, { action: 'comparisonData', snapshotId: nextComparison.snapshotId });
  rejects(handler, { action: 'textDiff', snapshotId: nextComparison.snapshotId });
  rejects(handler, { action: 'search', text: 'replacement' }, /JSON/);
  const restored = run(handler, { action: 'parse', text: numbers, retainSnapshot: true });
  assert.ok(restored.snapshotId > nextComparison.snapshotId);
});

test('non-retaining requests release their snapshots while preserving search behavior', () => {
  for (const action of ['format', 'parse', 'minify']) {
    const handler = createTaskHandler();
    const saved = run(handler, { action: 'parse', text: numbers, retainSnapshot: true });
    run(handler, { action, text: '{"current":"needle"}' });
    rejects(handler, { action: 'parseSnapshot', snapshotId: saved.snapshotId });
    assert.equal(run(handler, { action: 'search', text: 'needle' }).matchCount, 1);
  }
  const handler = createTaskHandler();
  const saved = run(handler, { action: 'diff', text: numbers, text2: reordered, retainSnapshot: true });
  run(handler, { action: 'diff', text: '{}', text2: '[]' });
  rejects(handler, { action: 'comparisonData', snapshotId: saved.snapshotId });
});

test('snapshots remain isolated between worker sessions', () => {
  const first = createTaskHandler();
  const second = createTaskHandler();
  const saved = run(first, { action: 'format', text: numbers, retainSnapshot: true });
  rejects(second, { action: 'parseSnapshot', snapshotId: saved.snapshotId });
  run(second, { action: 'clear' });
  assertNumberLiterals(run(first, { action: 'parseSnapshot', snapshotId: saved.snapshotId }));
});

test('cached keyed comparisons retain duplicate-key fallback and literal previews', () => {
  const handler = createTaskHandler();
  const request = {
    action: 'diff', keyField: 'id', retainSnapshot: true,
    text: '[{"id":1,"value":1.00},{"id":1,"value":2.00}]',
    text2: '[{"id":1,"value":3.00},{"id":1,"value":4.00}]',
  };
  const first = run(handler, request);
  const repeated = run(handler, request);
  assert.strictEqual(repeated.leftData, first.leftData);
  assert.strictEqual(repeated.rightData, first.rightData);
  assert.deepEqual(repeated.diffs, first.diffs);
  assert.deepEqual(repeated.stats, { added: 0, removed: 0, changed: 2, typeChanged: 0 });
  assert.equal(repeated.keyFallback, true);
  assert.equal(repeated.diffs[0].leftPreview, '1.00');
  assert.equal(repeated.diffs[0].rightPreview, '3.00');
  assert.equal(repeated.diffs[1].leftPath, '/1/value');
  assert.equal(repeated.diffs[1].rightPath, '/1/value');
  assert.equal(repeated.diffs[1].leftPreview, '2.00');
  assert.equal(repeated.diffs[1].rightPreview, '4.00');
});
