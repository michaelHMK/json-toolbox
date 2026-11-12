import test from 'node:test';
import assert from 'node:assert/strict';
import { searchData } from '../src/core/search.js';
import { appendJsonPath } from '../src/core/json-path.js';
import { parseJsonPreservingNumberLiterals } from '../src/core/json.js';

function referenceSearch(data, query) {
  const q = query.toLowerCase();
  const highlights = [];
  const forceExpand = new Set();
  let matchCount = 0;
  function visit(value, key, isIndex, path, ancestors) {
    const container = value !== null && typeof value === 'object';
    if ((key !== null && !isIndex && key.toLowerCase().includes(q))
      || (!container && String(value).toLowerCase().includes(q))) {
      matchCount++;
      if (highlights.length < 500) {
        highlights.push(path);
        for (const ancestor of ancestors) forceExpand.add(ancestor);
      }
    }
    if (container) {
      const isArray = Array.isArray(value);
      for (const key of Object.keys(value)) {
        visit(value[key], key, isArray, appendJsonPath(path, key), [...ancestors, path]);
      }
    }
  }
  visit(data, null, false, '', []);
  return { highlights, forceExpand: [...forceExpand], matchCount, truncated: matchCount > 500 };
}

test('search preserves DFS order and ancestor paths across matched keys and siblings', () => {
  const data = JSON.parse('{"a/b":{"~":{"Needle":1},"":"NEEDLE"},"needle":[{"nested":"needle"},"other"],"__proto__":"needle"}');
  assert.deepEqual(searchData(data, 'NeEdLe'), {
    highlights: ['/a~1b/~0/Needle', '/a~1b/', '/needle', '/needle/0/nested', '/__proto__'],
    forceExpand: ['', '/a~1b', '/a~1b/~0', '/needle', '/needle/0'],
    matchCount: 5,
    truncated: false,
  });
});

test('search counts every match after capping details without expanding later branches', () => {
  for (const count of [500, 501, 200_000]) {
    const data = { first: Array(500).fill('needle'), later: Array(count - 500).fill({ nested: 'needle' }) };
    const result = searchData(data, 'needle');
    assert.equal(result.matchCount, count);
    assert.equal(result.highlights.length, 500);
    assert.equal(result.highlights[0], '/first/0');
    assert.equal(result.highlights.at(-1), '/first/499');
    assert.deepEqual(result.forceExpand, ['', '/first']);
    assert.equal(result.truncated, count > 500);
  }
});

test('search handles primitive roots, empty containers and array indexes', () => {
  for (const data of [null, true, false, 12, 'VALUE', [], {}]) {
    for (const query of ['', 'value', 'null', '0', 'true']) {
      assert.deepEqual(searchData(data, query), referenceSearch(data, query));
    }
  }
  assert.equal(searchData(Array(100).fill('value'), '0').matchCount, 0);
  assert.deepEqual(searchData({ 0: 'value' }, '0').highlights, ['/0']);
});

test('search traverses deep containers without a recursive call stack', () => {
  let data = 'needle';
  const depth = 15_000;
  for (let i = 0; i < depth; i++) data = [data];
  assert.equal(searchData(data, 'absent').matchCount, 0);
  const result = searchData(data, 'needle');
  assert.deepEqual(result.highlights, ['/0'.repeat(depth)]);
  assert.equal(result.forceExpand.length, depth);
  assert.equal(result.forceExpand[0], '');
  assert.equal(result.forceExpand.at(-1), '/0'.repeat(depth - 1));
});

test('search agrees with a simple reference traversal for varied JSON values', () => {
  let seed = 0x12345678;
  const random = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  const keys = ['', '0', 'a/b', '~', 'needle', 'MixedCASE', '__proto__'];
  function build(depth) {
    const kind = random(depth ? 7 : 5);
    if (kind < 5) return [null, true, random(1000), 'Needle', 'other'][kind];
    if (kind === 5) return Array.from({ length: random(6) }, () => build(depth - 1));
    return Object.fromEntries(Array.from({ length: random(6) }, () => [keys[random(keys.length)], build(depth - 1)]));
  }
  for (let i = 0; i < 150; i++) {
    const data = build(5);
    for (const query of ['', 'needle', '0', 'true', '/', 'case', 'absent']) {
      assert.deepEqual(searchData(data, query), referenceSearch(data, query));
    }
  }
});

test('search matches displayed numeric literals at roots and escaped nested paths', () => {
  const parsed = parseJsonPreservingNumberLiterals('{"a/b":{"~":[1.20,9007199254740993,1E+02,1e400,-0]},"other":12}');
  for (const [query, path] of [
    ['1.20', '/a~1b/~0/0'], ['9007199254740993', '/a~1b/~0/1'],
    ['1e+02', '/a~1b/~0/2'], ['1e400', '/a~1b/~0/3'], ['-0', '/a~1b/~0/4'],
  ]) {
    const result = searchData(parsed.data, query, parsed.numberLiterals);
    assert.deepEqual(result.highlights, [path]);
    assert.deepEqual(result.forceExpand, ['', '/a~1b', '/a~1b/~0']);
  }
  for (const query of ['9007199254740992', 'Infinity', '100']) {
    assert.equal(searchData(parsed.data, query, parsed.numberLiterals).matchCount, 0);
  }
  assert.deepEqual(searchData(parsed.data, '12', parsed.numberLiterals).highlights, ['/other']);
  const root = parseJsonPreservingNumberLiterals('1.20');
  assert.deepEqual(searchData(root.data, '1.20', root.numberLiterals).highlights, ['']);
  const siblings = parseJsonPreservingNumberLiterals('[1.20,1.2,1.200]');
  assert.deepEqual(searchData(siblings.data, '1.20', siblings.numberLiterals).highlights, ['/0', '/2']);
  assert.deepEqual(searchData(siblings.data, '1.200', siblings.numberLiterals).highlights, ['/2']);
});

test('numeric literal search reuses ancestor paths across a deep wide array', () => {
  const depth = 5000;
  const source = '['.repeat(depth) + '['
    + Array.from({ length: 10_000 }, (_, i) => i).join(',') + ',1.20]' + ']'.repeat(depth);
  const { data, numberLiterals } = parseJsonPreservingNumberLiterals(source);
  const result = searchData(data, '1.20', numberLiterals);
  assert.deepEqual(result.highlights, ['/0'.repeat(depth) + '/10000']);
  assert.equal(result.matchCount, 1);
  assert.equal(result.forceExpand.length, depth + 1);
});
