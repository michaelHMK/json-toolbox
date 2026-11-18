import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskHandler } from '../src/worker/tasks.js';

function session(text) {
  const handle = createTaskHandler();
  const parsed = handle({ action: 'parse', text, retainSnapshot: true, includeData: false });
  assert.equal(parsed.ok, true);
  assert.equal(Object.hasOwn(parsed.result, 'data'), false);
  return { handle, request: (payload) => handle({ action: 'tree', snapshotId: parsed.result.snapshotId, ...payload }) };
}

test('Worker tree windows preserve numeric literals and counts without transferring subtrees', () => {
  const text = '[{"price":19.90,"huge":12345678901234567890,"text":"' + 'x'.repeat(10000) + '"},' + '0,'.repeat(100000) + '1]';
  const { request } = session(text);
  const initial = request({ operation: 'update', options: {}, count: 20 });
  assert.equal(initial.result.rowCount, 100004);
  assert.equal(initial.result.rows.length, 20);
  assert.deepEqual(initial.result.rows[0].value, []);
  assert.equal(initial.result.rows[0].size, 100002);
  assert.deepEqual(initial.result.rows[1].value, {});
  assert.equal(initial.result.rows[1].size, 3);
  const opened = request({ operation: 'setOpen', path: '/0', open: true, count: 20 });
  assert.equal(opened.result.rows.find((row) => row.path === '/0/price').literal, '19.90');
  assert.equal(opened.result.rows.find((row) => row.path === '/0/huge').literal, '12345678901234567890');
  const string = opened.result.rows.find((row) => row.path === '/0/text');
  assert.equal(string.valueLength, 10000);
  assert.equal(string.value.length, 2000);
  const end = request({ operation: 'reveal', path: '/100001', count: 10 });
  assert.equal(end.result.activePath, '/100001');
  assert.equal(end.result.activeRow.value, 1);
  assert.equal(end.result.activeIndex, end.result.revealIndex);
  assert.ok(end.result.rows.length <= 10);
});

test('Worker tree expansion, filtering and keyboard movement retain exact paths and visible active ancestors', () => {
  const { request } = session('{"a/b":{"~key":{"value":1}},"hidden":2}');
  const revealed = request({ operation: 'reveal', options: {}, path: '/a~1b/~0key/value' });
  assert.equal(revealed.result.activePath, '/a~1b/~0key/value');
  const closed = request({ operation: 'setOpen', path: '/a~1b', open: false, activePath: '/a~1b/~0key/value' });
  assert.equal(closed.result.activePath, '/a~1b');
  const moved = request({ operation: 'move', index: closed.result.activeIndex + 1, step: 1 });
  assert.equal(moved.result.activePath, '/hidden');
  const filtered = request({ operation: 'update', options: { onlyRequired: true, requiredChildren: new Map([['', new Set(['/hidden'])]]) }, activePath: '/a~1b' });
  assert.equal(filtered.result.activePath, '');
  assert.deepEqual(filtered.result.rows.map((row) => row.path), ['', '/hidden', '']);
});

test('Worker comparison owns both trees and rejects stale snapshots after clearing', () => {
  const handle = createTaskHandler();
  const diff = handle({
    action: 'diff', text: '{"branch":{"left":1,"same":0}}', text2: '{"branch":{"right":2,"same":0}}',
    includeData: false, retainSnapshot: true,
  });
  assert.equal(diff.result.leftData, undefined);
  const request = (side, onlyRequired) => handle({
    action: 'tree', operation: 'update', kind: 'comparison', side, options: { onlyRequired }, snapshotId: diff.result.snapshotId,
  });
  for (const side of ['left', 'right']) {
    const entries = (filtered) => request(side, filtered).result.rows.filter((row) => row.kind === 'entry').map((row) => row.path);
    assert.deepEqual(entries(false), ['', '/branch', '/branch/' + side, '/branch/same']);
    assert.deepEqual(entries(true), ['', '/branch', '/branch/' + side]);
  }
  handle({ action: 'clear' });
  assert.equal(request('left').code, 'SNAPSHOT_UNAVAILABLE');
});

test('a truncated root array still pairs the root and recorded moves', () => {
  const handle = createTaskHandler();
  const rows = Array.from({ length: 100001 }, (_, id) => ({ id }));
  const { result } = handle({
    action: 'diff', text: JSON.stringify(rows), text2: JSON.stringify([...rows.slice(1), rows[0]]),
    keyField: 'id', retainSnapshot: true, includeData: false,
  });
  assert.equal(result.total, 0);
  assert.equal(result.pairs.length, 100000);
  assert.equal(result.pairsTruncated, true);
  const check = (path, knownAncestor) => handle({
    action: 'comparisonPair', snapshotId: result.snapshotId, side: 'left', path, knownAncestor,
  }).result.allowed;
  assert.equal(check('', ''), true);
  assert.equal(check('/0/id', '/0'), true);
  assert.equal(check('/100000', ''), false);
});

test('a missing Worker tree explicitly requests configuration before accepting small operation messages', () => {
  const { request } = session('{"branch":{"n":1},"next":2}');
  assert.equal(request({ operation: 'rows', start: 0, count: 10 }).code, 'TREE_MODEL_UNAVAILABLE');
  const initialized = request({ operation: 'update', options: { expandLevel: 2 } });
  assert.equal(initialized.ok, true);
  const window = request({ operation: 'rows', start: 1, count: 3 });
  assert.equal(window.ok, true);
  assert.equal(window.result.rows[1].path, '/branch/n');
  const closed = request({ operation: 'setOpen', path: '/branch', open: false, activePath: '/branch/n' });
  assert.equal(closed.result.activePath, '/branch');
});

test('Worker child navigation enters only a visible direct child while normal movement skips closing rows', () => {
  const { request } = session('{"branch":{"hidden":1},"next":2}');
  const requiredChildren = new Map([['', new Set(['/branch', '/next'])]]);
  request({ operation: 'update', options: { expandLevel: Infinity, onlyRequired: true, requiredChildren } });
  const child = request({ operation: 'child', path: '/branch', activePath: '/branch' });
  assert.equal(child.result.activePath, '/branch');
  assert.equal(child.result.revealIndex, undefined);
  const moved = request({ operation: 'move', index: child.result.activeIndex + 1, step: 1 });
  assert.equal(moved.result.activePath, '/next');
  requiredChildren.set('/branch', new Set(['/branch/hidden']));
  request({ operation: 'update', options: { requiredChildren } });
  const visible = request({ operation: 'child', path: '/branch', activePath: '/branch' });
  assert.equal(visible.result.activePath, '/branch/hidden');
  assert.equal(visible.result.revealIndex, visible.result.activeIndex);
});

test('Worker supplies cloneable large text indexes for format and cached text comparisons', () => {
  const handle = createTaskHandler();
  const text = '[' + '19.90,'.repeat(80000) + '1]';
  const formatted = handle({ action: 'format', text, includeData: false, includeTextIndex: true });
  assert.equal(formatted.ok, true);
  assert.ok(formatted.result.lineIndex.starts instanceof Uint32Array);
  assert.equal(formatted.result.lineIndex.count, 80003);
  assert.doesNotThrow(() => structuredClone(formatted.result));
  const diff = handle({ action: 'diff', text, text2: text.replace('19.90', '2'), includeData: false, retainSnapshot: true });
  const lines = handle({ action: 'textDiff', snapshotId: diff.result.snapshotId, includeTextIndex: true });
  assert.equal(lines.ok, true);
  assert.equal(lines.result.aLineIndex.count, formatted.result.lineIndex.count);
  assert.equal(lines.result.bLineIndex.count, formatted.result.lineIndex.count);
  assert.doesNotThrow(() => structuredClone(lines.result));
});
