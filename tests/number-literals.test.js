import test from 'node:test';
import assert from 'node:assert/strict';
import { collectNumberLiterals, formatJson, parseJsonPreservingNumberLiterals } from '../src/core/json.js';
import { diffData } from '../src/core/structural-diff.js';

function compare(leftText, rightText, options = {}) {
  const left = parseJsonPreservingNumberLiterals(leftText);
  const right = parseJsonPreservingNumberLiterals(rightText);
  return diffData(left.data, right.data, {
    ...options, leftNumberLiterals: left.numberLiterals, rightNumberLiterals: right.numberLiterals,
  });
}

test('duplicate properties discard only superseded literal ranges', () => {
  const cases = [
    ['{"a":1.0,"a":2.00}', '{"a":2.00}'],
    ['{"a":0,"a":1.0,"a":2}', '{"a":2}'],
    ['{"a":{"x":1.0,"x":2.00},"a":{"y":3.00}}', '{"a":{"y":3.00}}'],
    ['{"a":{"x":1.0},"b":2.0,"a":{"x":3.0}}', '{"a":{"x":3.0},"b":2.0}'],
    ['{"a":{"x":1.0,"x":2},"b":3.0}', '{"a":{"x":2},"b":3.0}'],
    ['{"a":[{"x":1.0,"x":2.0},3.0],"a":[4.0]}', '{"a":[4.0]}'],
    ['{"a/b":{"~":1.0},"a/b":{},"__proto__":1.0,"__proto__":2.0}', '{"a/b":{},"__proto__":2.0}'],
    ['{"a":{"x":1.0,"x":{"n":2.0}},"a":{"x":3.0,"x":4.0}}', '{"a":{"x":4.0}}'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(formatJson(text, { indent: null }).text, expected);
    assert.deepEqual(collectNumberLiterals(text), collectNumberLiterals(expected));
  }
});

test('structural numeric comparison detects precision loss, overflow and underflow', () => {
  for (const [left, right] of [
    ['9007199254740993', '9007199254740992'],
    ['1.00000000000000001', '1'],
    ['1e400', '2e400'],
    ['1e-400', '0'],
    ['-1e-400', '1e-400'],
    ['1e999999999999999999999', '1e999999999999999999998'],
  ]) {
    assert.equal(compare(left, right).stats.changed, 1, `${left} vs ${right}`);
    const nested = compare('{"a/b":{"~":' + left + '}}', '{"a/b":{"~":' + right + '}}');
    assert.equal(nested.stats.changed, 1);
    assert.equal(nested.diffs[0].leftPath, '/a~1b/~0');
    assert.equal(nested.diffs[0].leftPreview, left);
    assert.equal(nested.diffs[0].rightPreview, right);
  }
});

test('structural numeric comparison ignores equivalent decimal spellings', () => {
  for (const [left, right] of [
    ['1.0', '1'], ['1.20', '1.2'], ['1E+02', '100'], ['-0', '0'],
    ['9007199254740993', '9007199254740993.00'],
    ['1e400', '10e399'], ['1e-400', '0.1e-399'],
    ['-0e999999', '0'], ['1e999999999999999999999', '10e999999999999999999998'],
  ]) assert.equal(compare(left, right).total, 0, `${left} vs ${right}`);
});

test('equal object references do not hide different literal maps', () => {
  const data = { value: 9007199254740992 };
  const result = diffData(data, data, { leftNumberLiterals: { '/value': '9007199254740993' } });
  assert.equal(result.stats.changed, 1);
});

test('primary keys preserve scalar types and exact numeric values when reordered', () => {
  const records = '[{"id":1,"v":1},{"id":"1","v":2},{"id":true,"v":3},{"id":"true","v":4}]';
  const reordered = '[{"id":"true","v":4},{"id":true,"v":3},{"id":"1","v":2},{"id":1,"v":1}]';
  const result = compare(records, reordered, { keyField: 'id' });
  assert.equal(result.total, 0);
  assert.equal(result.keyFallback, false);
  assert.equal(result.pairs.length, 4);
  const precise = compare(
    '[{"id":9007199254740993,"v":1},{"id":9007199254740992,"v":2}]',
    '[{"id":9007199254740992,"v":2},{"id":9007199254740993.0,"v":1}]',
    { keyField: 'id' },
  );
  assert.equal(precise.total, 0);
  assert.equal(precise.keyFallback, false);
  assert.deepEqual(precise.pairs, [['/0', '/1'], ['/1', '/0']]);
});

test('duplicate keys on either side fall back to index comparison', () => {
  const duplicates = '[{"id":1,"v":1},{"id":1.0,"v":2}]';
  const unique = '[{"id":1,"v":1},{"id":2,"v":2}]';
  for (const [left, right] of [[duplicates, duplicates], [duplicates, unique], [unique, duplicates]]) {
    const result = compare(left, right, { keyField: 'id' });
    assert.equal(result.keyFallback, true);
    assert.deepEqual(result.pairs, []);
    assert.deepEqual(result.diffs, compare(left, right).diffs);
  }
});

test('precision literals follow each side of nested keyed pairs with escaped key fields', () => {
  const result = compare(
    '{"list":[{"a/b":9007199254740993,"value":1.00000000000000001},{"a/b":9007199254740992,"value":1}]}',
    '{"list":[{"a/b":9007199254740992,"value":1.0},{"a/b":9007199254740993.0,"value":1}]}',
    { keyField: 'a/b' },
  );
  assert.equal(result.total, 1);
  assert.equal(result.keyFallback, false);
  assert.deepEqual(result.pairs, [['/list/0', '/list/1'], ['/list/1', '/list/0']]);
  assert.equal(result.diffs[0].leftPath, '/list/0/value');
  assert.equal(result.diffs[0].rightPath, '/list/1/value');
  assert.equal(result.diffs[0].leftPreview, '1.00000000000000001');
  assert.equal(result.diffs[0].rightPreview, '1');
});

test('identical retained documents skip scanning their shared literal table', () => {
  const { data, numberLiterals } = parseJsonPreservingNumberLiterals('[1.20,9007199254740993,1e400]');
  const unneededLiterals = new Proxy(numberLiterals, {
    ownKeys() { throw new Error('identical documents must not scan literals'); },
  });
  const result = diffData(data, data, {
    leftNumberLiterals: unneededLiterals, rightNumberLiterals: unneededLiterals,
  });
  assert.equal(result.total, 0);
});
