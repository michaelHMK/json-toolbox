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

test('line fingerprint collisions never hide changed lines', () => {
  // These distinct pairs collide under 32-bit FNV-1a; the second pair also
  // shares its length, so checking only the fingerprint and length is unsafe.
  for (const [left, right] of [['costarring', 'liquid'], ['declinate', 'macallums']]) {
    for (const [a, b] of [[left, right], [`same\n${left}\nend`, `same\n${right}\nend`]]) {
      const result = diffFormattedText(a, b);
      const counts = checkCoverage(result);
      assert.equal(result.blocky, false);
      assert.equal(counts.del, 1);
      assert.equal(counts.add, 1);
    }
  }
});

test('line indexes preserve LF boundaries, trailing empties, CR and UTF-16 content', () => {
  for (const [left, right] of [
    ['', '\n'], ['\n', ''], ['first\n', 'first'], ['\r\n', '\n'],
    ['\r', ''], ['一\n😀\n\ud800', '一\n😃\n\ud800'],
    ['a\r\nb\r\nc\r', 'a\r\nb\nc\r'],
  ]) {
    const result = diffFormattedText(left, right);
    assert.equal(result.blocky, false);
    checkCoverage(result);
    assert.deepEqual(result.totalLines, [left.split('\n').length, right.split('\n').length]);
  }
});

test('randomized indexed diff matches an independent shortest-edit oracle', () => {
  const alphabet = ['', 'same', '\r', '一', '😀', 'declinate', 'macallums'];
  let seed = 19017;
  const random = (max) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  for (let sample = 0; sample < 300; sample++) {
    const left = Array.from({ length: 1 + random(20) }, () => alphabet[random(alphabet.length)]);
    const right = Array.from({ length: 1 + random(20) }, () => alphabet[random(alphabet.length)]);
    let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
    for (let a = 1; a <= left.length; a++) {
      const current = [a];
      for (let b = 1; b <= right.length; b++) {
        current[b] = left[a - 1] === right[b - 1]
          ? previous[b - 1] : Math.min(previous[b], current[b - 1]) + 1;
      }
      previous = current;
    }
    const result = diffFormattedText(left.join('\n'), right.join('\n'));
    const counts = checkCoverage(result);
    assert.equal(result.blocky, false);
    assert.equal(counts.del + counts.add, previous[right.length]);
  }
});
