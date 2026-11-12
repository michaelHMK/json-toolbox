import test from 'node:test';
import assert from 'node:assert/strict';
import { diffData } from '../src/core/structural-diff.js';
import { makeTextDiff } from '../src/core/text-diff.js';
import { collectNumberLiterals } from '../src/core/json.js';
import { performance } from 'node:perf_hooks';

function checkTextDiff(result) {
  const a = result.aText.split('\n');
  const b = result.bText.split('\n');
  let aIndex = 0;
  let bIndex = 0;
  let changes = 0;
  for (const op of result.ops) {
    assert.ok(op.count > 0);
    if (op.type !== 'add') {
      assert.equal(op.aStart, aIndex);
      aIndex += op.count;
    }
    if (op.type !== 'del') {
      assert.equal(op.bStart, bIndex);
      bIndex += op.count;
    }
    if (op.type === 'same') {
      assert.deepEqual(a.slice(op.aStart, aIndex), b.slice(op.bStart, bIndex));
    } else {
      changes += op.count;
    }
  }
  assert.equal(aIndex, a.length);
  assert.equal(bIndex, b.length);
  return { a, b, changes };
}

// 独立的小规模动态规划参照，验证回溯仍然给出最短插入/删除序列。
function minimumChanges(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1]
        ? previous[j - 1] : Math.min(previous[j], current[j - 1]) + 1;
    }
    previous = current;
  }
  return previous[b.length];
}

test('text diff keeps shortest edits for repeated lines, insertions and deletions', () => {
  let seed = 7213;
  const random = (max) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 16) % max;
  };
  for (let i = 0; i < 200; i++) {
    const left = Array.from({ length: random(20) }, () => random(6));
    const right = Array.from({ length: random(20) }, () => random(6));
    const result = makeTextDiff(JSON.stringify(left), JSON.stringify(right), '2');
    assert.equal(result.blocky, false);
    const { a, b, changes } = checkTextDiff(result);
    assert.equal(changes, minimumChanges(a, b));
  }
});

test('identical formatted text reports one complete same range', () => {
  const value = Array.from({ length: 2000 }, (_, i) => ({ id: i, text: 'line\\ntext' }));
  const left = JSON.stringify(value);
  for (const right of [left, JSON.stringify(value, null, 4)]) {
    const result = makeTextDiff(left, right, '2');
    assert.equal(result.ops.length, 1);
    assert.equal(checkTextDiff(result).changes, 0);
    assert.deepEqual(result.totalLines, [result.ops[0].count, result.ops[0].count]);
  }
});

test('text diff handles worst-case exact diff and the block replacement boundary', () => {
  for (const size of [1500, 1501]) {
    const left = JSON.stringify(Array.from({ length: size }, (_, i) => `left ${i}`));
    const right = JSON.stringify(Array.from({ length: size }, (_, i) => `right ${i}`));
    const result = makeTextDiff(left, right, '2');
    assert.equal(result.blocky, size > 1500);
    assert.equal(checkTextDiff(result).changes, size * 2);
  }
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
  assert.deepEqual(result.diffs.map(({ type, leftPath, rightPath }) => [type, leftPath, rightPath]), [
    ['removed', '/list/1', null],
    ['added', null, '/list/0'],
    ['added', null, '/list/2'],
    ['changed', '/metadata/update', '/metadata/update'],
  ]);
  assert.equal(result.keyFallback, false);
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


test('duplicate keys do not rescan unrelated numeric literal paths', () => {
  const count = 20_000;
  const text = '{"n":[' + Array(count).fill('1.0').join(',') + '],"o":{'
    + Array.from({ length: count }, (_, i) => '"k":' + i).join(',') + '}}';
  const started = performance.now();
  const literals = collectNumberLiterals(text);
  const elapsed = performance.now() - started;
  assert.equal(Object.keys(literals).length, count);
  assert.equal(literals['/n/0'], '1.0');
  assert.equal(literals['/n/' + (count - 1)], '1.0');
  assert.ok(elapsed < 2000, `literal scan took ${elapsed.toFixed(0)} ms`);
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
