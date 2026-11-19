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

function readTree(handler, snapshotId, { kind = 'document', side, expandLevel = Infinity } = {}) {
  return run(handler, {
    action: 'tree', operation: 'update', kind, ...(side ? { side } : {}),
    snapshotId, options: { expandLevel }, count: 64,
  });
}

function assertNumberLiterals(handler, snapshotId, options = {}) {
  const tree = readTree(handler, snapshotId, options);
  const byPath = new Map(tree.rows.filter((row) => row.kind === 'entry').map((row) => [row.path, row]));
  assert.equal(byPath.get('/a~1b/~0/0').literal, '9007199254740993');
  assert.equal(byPath.get('/a~1b/~0/1').literal, '1.2300');
  assert.equal(byPath.get('/a~1b/~0/2').literal, '1e400');
  assert.equal(byPath.get('/a~1b/~0/2').value, Infinity);
  assert.equal(byPath.get('/a~1b/~0/3').literal, '-0');
  assert.equal(Object.is(byPath.get('/a~1b/~0/3').value, -0), true);
  assert.equal(byPath.get('/exp').literal, '1E+02');
}

test('snapshot retention is opt-in and responses never transfer parsed object graphs', () => {
  const handler = createTaskHandler();
  assert.deepEqual(Object.keys(run(handler, { action: 'format', text: '{}' })), ['text']);
  assert.deepEqual(Object.keys(run(handler, { action: 'parse', text: '{}' })), []);
  assert.deepEqual(Object.keys(run(handler, { action: 'minify', text: '{}' })), ['text']);
  const diff = run(handler, { action: 'diff', text: '{}', text2: '{"value":1}' });
  assert.equal(Object.hasOwn(diff, 'snapshotId'), false);
  for (const key of ['leftData', 'rightData', 'leftNumberLiterals', 'rightNumberLiterals']) {
    assert.equal(Object.hasOwn(diff, key), false);
  }
  const textDiff = run(handler, { action: 'textDiff', text: '{}', text2: '{}' });
  assert.deepEqual(Object.keys(textDiff).sort(), ['aText', 'bText', 'blocky', 'ops', 'totalLines']);
  rejects(handler, { action: 'tree', kind: 'document', snapshotId: 1, options: {} });
  rejects(handler, { action: 'tree', kind: 'comparison', side: 'left', snapshotId: 1, options: {} });
  rejects(handler, { action: 'textDiff', snapshotId: 1 });
});

test('format snapshots lazily populate original literals and reuse parsing across reformatting', (t) => {
  const handler = createTaskHandler();
  const formatted = run(handler, { action: 'format', text: numbers, retainSnapshot: true });
  assert.deepEqual(Object.keys(formatted), ['text', 'snapshotId']);
  const parseSpy = t.mock.method(JSON, 'parse');
  assertNumberLiterals(handler, formatted.snapshotId);
  const reformatted = run(handler, { action: 'format', text: numbers, indent: '4', retainSnapshot: true });
  assert.equal(parseSpy.mock.callCount(), 0, 'reformatting the same source reuses cached parsed data');
  assert.match(reformatted.text, /\n    "a\/b":/);
  assert.notEqual(reformatted.snapshotId, formatted.snapshotId);
  assertNumberLiterals(handler, reformatted.snapshotId);
  rejects(handler, { action: 'tree', kind: 'document', snapshotId: formatted.snapshotId, options: {} });
});

test('cached format and parse preserve key reordering, duplicate keys and normalized strings', (t) => {
  const handler = createTaskHandler();
  const formatted = run(handler, { action: 'format', text: reordered, retainSnapshot: true });
  const parseSpy = t.mock.method(JSON, 'parse');
  const tree = readTree(handler, formatted.snapshotId);
  const top = tree.rows.filter((row) => row.kind === 'entry' && row.depth === 1);
  assert.deepEqual(top.map((row) => row.key), ['1', '2', 'x', 's', '__proto__']);
  assert.equal(top.find((row) => row.path === '/x').literal, '3.00');
  assert.equal(top.find((row) => row.path === '/s').value, '中/');
  assert.equal(top.find((row) => row.path === '/__proto__').literal, '4.00');
  assert.equal(top.find((row) => row.path === '/1').literal, '1E+02');
  for (const text of [reordered, formatted.text]) {
    const parsed = run(handler, { action: 'parse', text, retainSnapshot: true });
    assert.equal(parsed.snapshotId, formatted.snapshotId);
  }
  const tabbed = run(handler, { action: 'format', text: reordered, indent: 'tab', retainSnapshot: true });
  assert.equal(parseSpy.mock.callCount(), 0);
  assert.match(tabbed.text, /^\{\n\t"1": 1E\+02,/);
  assert.equal(tabbed.text.includes('old'), false);
});

test('parse snapshots reuse parsed data for repeated parsing and subsequent formatting', (t) => {
  const handler = createTaskHandler();
  const first = run(handler, { action: 'parse', text: numbers, retainSnapshot: true });
  const parseSpy = t.mock.method(JSON, 'parse');
  const second = run(handler, { action: 'parse', text: numbers, retainSnapshot: true });
  const formatted = run(handler, { action: 'format', text: numbers, retainSnapshot: true });
  assert.equal(parseSpy.mock.callCount(), 0);
  assert.equal(second.snapshotId, first.snapshotId);
  assertNumberLiterals(handler, formatted.snapshotId);
});

test('comparison summaries omit trees and expose exact literals through Worker tree windows', () => {
  const handler = createTaskHandler();
  const right = numbers.replace('1.2300', '2.3400');
  const summary = run(handler, { action: 'diff', text: numbers, text2: right, retainSnapshot: true });
  for (const key of ['leftData', 'rightData', 'leftNumberLiterals', 'rightNumberLiterals']) {
    assert.equal(Object.hasOwn(summary, key), false);
  }
  assert.equal(summary.total, 1);
  assert.equal(summary.diffs[0].leftPreview, '1.2300');
  assert.equal(summary.diffs[0].rightPreview, '2.3400');
  assertNumberLiterals(handler, summary.snapshotId, { kind: 'comparison', side: 'left' });
  const rightTree = readTree(handler, summary.snapshotId, { kind: 'comparison', side: 'right' });
  assert.equal(rightTree.rows.find((row) => row.path === '/a~1b/~0/1').literal, '2.3400');
});

test('repeated and swapped comparisons reuse both parsed sides while recomputing options', (t) => {
  const handler = createTaskHandler();
  const left = '{"rows":[{"id":1,"value":1.00},{"id":2,"value":2.00}]}';
  const right = '{"rows":[{"id":2,"value":3.00},{"id":1,"value":4.00}]}';
  const initial = run(handler, { action: 'diff', text: left, text2: right, retainSnapshot: true });
  const parseSpy = t.mock.method(JSON, 'parse');
  const keyed = run(handler, {
    action: 'diff', text: left, text2: right, keyField: 'id',
    ignorePaths: ['rows[*].value'], retainSnapshot: true,
  });
  assert.equal(keyed.total, 0);
  assert.deepEqual(keyed.pairs, [['/rows/0', '/rows/1'], ['/rows/1', '/rows/0']]);
  const swapped = run(handler, { action: 'diff', text: right, text2: left, retainSnapshot: true });
  assert.equal(parseSpy.mock.callCount(), 0, 'repeated and swapped diffs reuse cached sides');
  assert.equal(swapped.total, initial.total);
  const swappedLeft = readTree(handler, swapped.snapshotId, { kind: 'comparison', side: 'left' });
  assert.equal(swappedLeft.rows.find((row) => row.path === '/rows/0/value').literal, '3.00');
  rejects(handler, { action: 'tree', kind: 'comparison', side: 'left', snapshotId: keyed.snapshotId, options: {} });
});

test('replacing just one comparison side retains the other parsed object', (t) => {
  const handler = createTaskHandler();
  run(handler, { action: 'diff', text: reordered, text2: numbers, retainSnapshot: true });
  const parseSpy = t.mock.method(JSON, 'parse');
  const changed = run(handler, { action: 'diff', text: reordered, text2: '{"new":true}', retainSnapshot: true });
  assert.equal(parseSpy.mock.callCount(), 1, 'only the changed right side is parsed');
  const leftTree = readTree(handler, changed.snapshotId, { kind: 'comparison', side: 'left' });
  assert.equal(leftTree.rows.find((row) => row.path === '/x').value, 3);
  const rightTree = readTree(handler, changed.snapshotId, { kind: 'comparison', side: 'right' });
  assert.equal(rightTree.rows.find((row) => row.path === '/new').value, true);
});

test('view-only text diff needs only snapshot id and invalidates its result on indentation changes', () => {
  const handler = createTaskHandler();
  const right = reordered.replace('3.00', '5.00');
  const compared = run(handler, { action: 'diff', text: reordered, text2: right, retainSnapshot: true });
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

test('identical comparison inputs share one parsed object and yield one unchanged text range', (t) => {
  const handler = createTaskHandler();
  const parseSpy = t.mock.method(JSON, 'parse');
  const compared = run(handler, { action: 'diff', text: numbers, text2: numbers, retainSnapshot: true });
  assert.equal(parseSpy.mock.callCount(), 1, 'identical left and right inputs parse once');
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
    assert.equal(readTree(handler, document.snapshotId).rows.find((row) => row.path === '/keep').value, 'needle');
    assert.equal(readTree(handler, compared.snapshotId, { kind: 'comparison', side: 'left' }).rows.find((row) => row.path === '/exp').literal, '1E+02');
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
  rejects(handler, { action: 'tree', kind: 'document', snapshotId: oldDocument.snapshotId, options: {} });
  rejects(handler, { action: 'tree', kind: 'comparison', side: 'left', snapshotId: oldComparison.snapshotId, options: {} });
  rejects(handler, { action: 'textDiff', snapshotId: oldComparison.snapshotId });
  rejects(handler, { action: 'tree', kind: 'document', snapshotId: nextComparison.snapshotId, options: {} });
  rejects(handler, { action: 'tree', kind: 'comparison', side: 'left', snapshotId: nextDocument.snapshotId, options: {} });
  assert.deepEqual(run(handler, { action: 'clear' }), {});
  rejects(handler, { action: 'tree', kind: 'document', snapshotId: nextDocument.snapshotId, options: {} });
  rejects(handler, { action: 'tree', kind: 'comparison', side: 'left', snapshotId: nextComparison.snapshotId, options: {} });
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
    rejects(handler, { action: 'tree', kind: 'document', snapshotId: saved.snapshotId, options: {} });
    assert.equal(run(handler, { action: 'search', text: 'needle' }).matchCount, 1);
  }
  const handler = createTaskHandler();
  const saved = run(handler, { action: 'diff', text: numbers, text2: reordered, retainSnapshot: true });
  run(handler, { action: 'diff', text: '{}', text2: '[]' });
  rejects(handler, { action: 'tree', kind: 'comparison', side: 'left', snapshotId: saved.snapshotId, options: {} });
});

test('snapshots remain isolated between worker sessions', () => {
  const first = createTaskHandler();
  const second = createTaskHandler();
  const saved = run(first, { action: 'format', text: numbers, retainSnapshot: true });
  rejects(second, { action: 'tree', kind: 'document', snapshotId: saved.snapshotId, options: {} });
  run(second, { action: 'clear' });
  assertNumberLiterals(first, saved.snapshotId);
});

test('cached keyed comparisons retain duplicate-key fallback and literal previews', (t) => {
  const handler = createTaskHandler();
  const request = {
    action: 'diff', keyField: 'id', retainSnapshot: true,
    text: '[{"id":1,"value":1.00},{"id":1,"value":2.00}]',
    text2: '[{"id":1,"value":3.00},{"id":1,"value":4.00}]',
  };
  const first = run(handler, request);
  const parseSpy = t.mock.method(JSON, 'parse');
  const repeated = run(handler, request);
  assert.equal(parseSpy.mock.callCount(), 0);
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
