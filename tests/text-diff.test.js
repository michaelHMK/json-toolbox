import test from 'node:test';
import assert from 'node:assert/strict';
import { diffFormattedText, makeTextDiff } from '../src/core/text-diff.js';

function checkCoverage(result) {
  const left = result.aText.split('\n');
  const right = result.bText.split('\n');
  let aIndex = 0;
  let bIndex = 0;
  const counts = { same: 0, del: 0, add: 0 };
  for (const op of result.ops) {
    assert.ok(op.count > 0);
    counts[op.type] += op.count;
    if (op.type !== 'add') {
      assert.equal(op.aStart, aIndex);
      aIndex += op.count;
    }
    if (op.type !== 'del') {
      assert.equal(op.bStart, bIndex);
      bIndex += op.count;
    }
    if (op.type === 'same') {
      assert.deepEqual(left.slice(op.aStart, aIndex), right.slice(op.bStart, bIndex));
    }
  }
  assert.equal(aIndex, left.length);
  assert.equal(bIndex, right.length);
  return counts;
}

test('large JSON with changes at both ends keeps its unchanged middle', () => {
  const left = Array.from({ length: 3604 }, (_, i) => i);
  const right = [...left];
  right[0] = -1;
  right[right.length - 1] = -1;
  const result = makeTextDiff(JSON.stringify(left), JSON.stringify(right), '2');
  assert.deepEqual(result.totalLines, [3606, 3606]);
  assert.equal(result.blocky, false);
  assert.deepEqual(checkCoverage(result), { same: 3604, del: 2, add: 2 });
});

test('sparse edits stay exact even when the unmatched span has tens of thousands of lines', () => {
  const left = Array.from({ length: 30_000 }, (_, i) => `line ${i}`);
  const right = [...left];
  right.splice(29_999, 1, 'replacement');
  right.splice(15_000, 1);
  right.splice(1, 0, 'insertion');
  const result = diffFormattedText(left.join('\n'), right.join('\n'));
  assert.equal(result.blocky, false);
  assert.deepEqual(checkCoverage(result), { same: 29_998, del: 2, add: 2 });
});

test('large disjoint documents stop at the edit budget and retain common boundaries', () => {
  const left = ['[', ...Array.from({ length: 20_000 }, (_, i) => `left ${i}`), ']'];
  const right = ['[', ...Array.from({ length: 20_000 }, (_, i) => `right ${i}`), ']'];
  const started = performance.now();
  const result = diffFormattedText(left.join('\n'), right.join('\n'));
  const elapsed = performance.now() - started;
  assert.equal(result.blocky, true);
  assert.deepEqual(checkCoverage(result), { same: 2, del: 20_000, add: 20_000 });
  assert.ok(elapsed < 5000, `bounded diff took ${elapsed.toFixed(0)} ms`);
});

test('large one-sided insertions do not need an approximate replacement', () => {
  const left = '[\n]';
  const middle = Array.from({ length: 10_000 }, (_, i) => `  ${i},`);
  const right = ['[', ...middle, ']'].join('\n');
  for (const [a, b, counts] of [
    [left, right, { same: 2, del: 0, add: 10_000 }],
    [right, left, { same: 2, del: 10_000, add: 0 }],
  ]) {
    const result = diffFormattedText(a, b);
    assert.equal(result.blocky, false);
    assert.deepEqual(checkCoverage(result), counts);
  }
});
