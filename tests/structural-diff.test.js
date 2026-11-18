import test from 'node:test';
import assert from 'node:assert/strict';
import { diffData } from '../src/core/structural-diff.js';
import { performance } from 'node:perf_hooks';

test('structural diff counts type changes across JSON primitives and containers', () => {
  const result = diffData(
    { qty: 7, flag: null, items: [], value: 'old', active: false, extra: {} },
    { qty: '7', flag: false, items: {}, value: 'new', active: true, extra: null },
  );
  assert.deepEqual(result.stats, { added: 0, removed: 0, changed: 2, typeChanged: 4 });
  assert.deepEqual(result.diffs.map(({ leftPath, type }) => [leftPath, type]), [
    ['/qty', 'typeChanged'], ['/flag', 'typeChanged'], ['/items', 'typeChanged'],
    ['/value', 'changed'], ['/active', 'changed'], ['/extra', 'typeChanged'],
  ]);
});

test('structural diff retains independent escaped sibling paths and numeric previews', () => {
  const left = { 'a/b': { '~': [1, { value: 2 }] }, sibling: { gone: false } };
  const right = { 'a/b': { '~': [3, { value: 4, added: true }] }, sibling: { next: null } };
  const result = diffData(left, right, {
    leftNumberLiterals: { '/a~1b/~0/0': '1.00', '/a~1b/~0/1/value': '2e0' },
    rightNumberLiterals: { '/a~1b/~0/0': '3.00', '/a~1b/~0/1/value': '4e0' },
  });
  assert.deepEqual(result.diffs.map(({ type, leftPath, rightPath, leftPreview, rightPreview }) =>
    [type, leftPath, rightPath, leftPreview, rightPreview]), [
    ['changed', '/a~1b/~0/0', '/a~1b/~0/0', '1.00', '3.00'],
    ['changed', '/a~1b/~0/1/value', '/a~1b/~0/1/value', '2e0', '4e0'],
    ['added', null, '/a~1b/~0/1/added', '', 'true'],
    ['removed', '/sibling/gone', null, 'false', ''],
    ['added', null, '/sibling/next', '', 'null'],
  ]);
});

test('keyed arrays keep unique-key matching, nested pairs and exact ignore semantics', () => {
  const left = {
    list: [{ id: 1, child: [{ id: 'a', value: 1 }, { id: 'b', value: 2 }] }, { id: 3 }],
    metadata: { update: 1 },
  };
  const right = {
    list: [{ id: 2 }, { id: 1, child: [{ id: 'b', value: 3 }, { id: 'a', value: 4 }] }, { id: 4 }],
    metadata: { update: 2 },
  };
  const result = diffData(left, right, {
    keyField: 'id', ignorePaths: ['list[*].child[*].value', 'metadata'],
  });
  assert.deepEqual(result.pairs, [
    ['/list/0', '/list/1'],
    ['/list/0/child/0', '/list/1/child/1'],
    ['/list/0/child/1', '/list/1/child/0'],
  ]);
  assert.deepEqual(result.unpaired.left.get('/list'), [1, 1]);
  assert.deepEqual(result.unpaired.right.get('/list'), [0, 0, 2, 2]);
  assert.equal(result.pairsTruncated, false);
  assert.deepEqual(result.diffs.map(({ type, leftPath, rightPath }) => [type, leftPath, rightPath]), [
    ['removed', '/list/1', null],
    ['added', null, '/list/0'],
    ['added', null, '/list/2'],
    ['changed', '/metadata/update', '/metadata/update'],
  ]);
  assert.equal(result.keyFallback, false);
});

test('large consecutive additions and removals use one range per array side', () => {
  let left = Array.from({ length: 100000 }, (_, id) => ({ id }));
  let right = left.map(({ id }) => ({ id: id + left.length }));
  for (let i = 0; i < 20; i++) { left = { nested: left }; right = { nested: right }; }
  const result = diffData(left, right, { keyField: 'id' });
  const parent = '/nested'.repeat(20);
  assert.deepEqual(result.unpaired.left, new Map([[parent, [0, 99999]]]));
  assert.deepEqual(result.unpaired.right, new Map([[parent, [0, 99999]]]));
  assert.equal(result.pairs.length, 0);
  assert.equal(result.pairsTruncated, false);
  assert.deepEqual(result.stats, { added: 100000, removed: 100000, changed: 0, typeChanged: 0 });
});

test('identical references report key fallback without duplicate-key differences', () => {
  const value = { list: [1, 2] };
  assert.equal(diffData(value, value).total, 0);
  assert.equal(diffData(value, value, { keyField: 'id' }).keyFallback, true);
  const duplicates = [{ id: 1 }, { id: 1 }];
  const result = diffData(duplicates, duplicates, { keyField: 'id' });
  assert.equal(result.total, 0);
  assert.equal(result.keyFallback, true);
});

test('structural diff handles 20,000 nested objects and restores sibling paths', () => {
  const depth = 20_000;
  const prefix = '{"branch":' + '{"x":'.repeat(depth);
  const suffix = '}'.repeat(depth);
  const left = JSON.parse(prefix + '0' + suffix + ',"sibling":0}');
  const right = JSON.parse(prefix + '1' + suffix + ',"sibling":1}');
  const result = diffData(left, right);
  const deepPath = '/branch' + '/x'.repeat(depth);
  assert.equal(result.total, 2);
  assert.deepEqual(result.diffs.map(({ type, leftPath, rightPath }) => [type, leftPath, rightPath]), [
    ['changed', deepPath, deepPath],
    ['changed', '/sibling', '/sibling'],
  ]);
});

test('structural diff handles deeply nested keyed arrays and exact ignored leaves', () => {
  const depth = 5_000;
  const prefix = '[{"id":0,"next":'.repeat(depth);
  const suffix = '}]'.repeat(depth);
  const left = JSON.parse(prefix + '{"value":1,"gone":true}' + suffix);
  const right = JSON.parse(prefix + '{"value":2,"added":true}' + suffix);
  const ignoredLeaf = '[0].next.'.repeat(depth) + 'value';
  const result = diffData(left, right, { keyField: 'id', ignorePaths: [ignoredLeaf] });
  const path = '/0/next'.repeat(depth);
  assert.equal(result.total, 2);
  assert.equal(result.keyFallback, false);
  assert.deepEqual(result.pairs, []);
  assert.deepEqual(result.diffs.map(({ type, leftPath, rightPath }) => [type, leftPath, rightPath]), [
    ['removed', path + '/gone', null],
    ['added', null, path + '/added'],
  ]);
});

test('iterative structural diff keeps detail caps after returning from a deep branch', () => {
  const depth = 3_000;
  const prefix = '{"child":'.repeat(depth);
  const suffix = '}'.repeat(depth);
  const left = { deep: JSON.parse(prefix + '0' + suffix), wide: Array(5001).fill(0) };
  const right = { deep: JSON.parse(prefix + '1' + suffix), wide: Array(5001).fill(1) };
  const result = diffData(left, right);
  assert.equal(result.total, 5002);
  assert.equal(result.diffs.length, 5000);
  assert.equal(result.truncated, true);
  assert.equal(result.diffs[0].leftPath, '/deep' + '/child'.repeat(depth));
  assert.equal(result.diffs[4999].leftPath, '/wide/4998');
});

test('sparse precision literals do not rebuild paths for a deep array of equal numbers', () => {
  const depth = 5000;
  const count = 10_000;
  let left = Array(count).fill(9007199254740992);
  let right = [...left];
  for (let i = 0; i < depth; i++) { left = [left]; right = [right]; }
  const prefix = '/0'.repeat(depth);
  const started = performance.now();
  const result = diffData(left, right, {
    leftNumberLiterals: { [prefix + '/9999']: '9007199254740993' },
    rightNumberLiterals: { [prefix + '/9998']: '9007199254740993' },
  });
  const elapsed = performance.now() - started;
  assert.equal(result.total, 2);
  assert.deepEqual(result.diffs.map(({ type, leftPath, rightPath }) => [type, leftPath, rightPath]), [
    ['changed', prefix + '/9998', prefix + '/9998'],
    ['changed', prefix + '/9999', prefix + '/9999'],
  ]);
  assert.ok(elapsed < 1500, `deep numeric array diff took ${elapsed.toFixed(0)} ms`);
});

test('a precision literal at the end of a deep numeric chain keeps traversal linear', () => {
  const depth = 10_000;
  let left = 1;
  let right = 1;
  for (let i = 0; i < depth; i++) {
    left = { number: 1, next: left };
    right = { number: 1, next: right };
  }
  const path = '/next'.repeat(depth);
  const started = performance.now();
  const result = diffData(left, right, {
    leftNumberLiterals: { [path]: '1.00000000000000001' },
    rightNumberLiterals: { [path]: '1.00000000000000001' },
  });
  const elapsed = performance.now() - started;
  assert.equal(result.total, 0);
  assert.ok(elapsed < 1500, `deep numeric chain diff took ${elapsed.toFixed(0)} ms`);
});
