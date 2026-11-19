import test from 'node:test';
import assert from 'node:assert/strict';
import { createChildPathIndex } from '../src/core/json-path.js';

test('child-path index preserves encoded keys and deduplicates shared ancestors', () => {
  const index = createChildPathIndex([
    '', '/a~1b', '/a~1b/~0/x', '/a~1b/~0', '/a~1b/other', '/', '/~01', '/a~1b/~0/x',
  ]);
  assert.deepEqual([...index.get('')], ['/a~1b', '/', '/~01']);
  assert.deepEqual([...index.get('/a~1b')], ['/a~1b/~0', '/a~1b/other']);
  assert.deepEqual([...index.get('/a~1b/~0')], ['/a~1b/~0/x']);
  assert.equal(index.size, 3);
  assert.equal(createChildPathIndex(['']).size, 0);
});

test('child-path index links each sparse descendant through its immediate ancestors', () => {
  const index = createChildPathIndex(['/items/999999/value', '/items/5/value', '/items/999999/other']);
  assert.deepEqual([...index.get('')], ['/items']);
  assert.deepEqual([...index.get('/items')], ['/items/999999', '/items/5']);
  assert.deepEqual([...index.get('/items/999999')], ['/items/999999/value', '/items/999999/other']);
  assert.deepEqual([...index.get('/items/5')], ['/items/5/value']);
});
