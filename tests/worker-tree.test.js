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
  const initial = request({ operation: 'update', count: 20 });
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
  const revealed = request({ operation: 'reveal', path: '/a~1b/~0key/value' });
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
  const diff = handle({ action: 'diff', text: '{"left":1}', text2: '{"right":2}', includeData: false, retainSnapshot: true });
  assert.equal(diff.result.leftData, undefined);
  const request = (side) => handle({ action: 'tree', kind: 'comparison', side, snapshotId: diff.result.snapshotId });
  assert.equal(request('left').result.rows[1].value, 1);
  assert.equal(request('right').result.rows[1].value, 2);
  handle({ action: 'clear' });
  assert.equal(request('left').code, 'SNAPSHOT_UNAVAILABLE');
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
