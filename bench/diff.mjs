import { performance } from 'node:perf_hooks';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// node --expose-gc bench/diff.mjs [source directory or file URL]
// TEXT_DIFF_BENCH_LINES=2180000 adds a report-sized sparse-edit case. The
// default also exercises this path, at a scale suitable for the normal suite.
// Memory deltas are measured immediately after each call, before a forced GC.
// They include temporary allocations awaiting GC and are not peak/retained memory.
const sourceArg = process.argv[2];
const sourceUrl = sourceArg
  ? sourceArg.startsWith('file:')
    ? new URL(sourceArg.endsWith('/') ? sourceArg : sourceArg + '/')
    : pathToFileURL(resolve(sourceArg) + sep)
  : new URL('../src/core/', import.meta.url);
const { diffData } = await import(new URL('structural-diff.js', sourceUrl));
const { makeTextDiff, diffFormattedText } = await import(new URL('text-diff.js', sourceUrl));

console.log(JSON.stringify({
  node: process.version, source: sourceUrl.href, warmups: 2, samples: 7,
  forcedGc: typeof globalThis.gc === 'function',
  memoryMeasurement: 'Post-call minus pre-call; includes allocations awaiting GC, not peak or retained memory.',
}));

function median(values) {
  values.sort((a, b) => a - b);
  return +values[Math.floor(values.length / 2)].toFixed(2);
}

function measure(name, run, verify) {
  for (let i = 0; i < 2; i++) verify(run());
  const timings = [];
  const heapDeltas = [];
  const arrayBufferDeltas = [];
  let result;
  for (let i = 0; i < 7; i++) {
    result = undefined;
    globalThis.gc?.();
    const before = process.memoryUsage();
    const start = performance.now();
    result = run();
    timings.push(performance.now() - start);
    const after = process.memoryUsage();
    heapDeltas.push((after.heapUsed - before.heapUsed) / 1024 / 1024);
    arrayBufferDeltas.push((after.arrayBuffers - before.arrayBuffers) / 1024 / 1024);
    verify(result);
  }
  console.log(JSON.stringify({
    name, medianMs: median(timings), medianHeapDeltaMiB: median(heapDeltas),
    medianArrayBufferDeltaMiB: median(arrayBufferDeltas),
  }));
}

const rows = Array.from({ length: 50_000 }, (_, i) => ({
  id: i, name: `row ${i}`, nested: { value: i, flags: [true, false], metadata: { active: true } },
}));
const copied = structuredClone(rows);
const reversed = [...copied].reverse();
const unchanged = (result) => {
  if (result.total !== 0) throw new Error('Expected identical structure');
};

measure('structure-50k-equal', () => diffData(rows, copied), unchanged);
measure('structure-50k-keyed-reversed', () => diffData(rows, reversed, { keyField: 'id' }), (result) => {
  unchanged(result);
  if (result.pairs.length !== rows.length) throw new Error('Expected all rows paired by key');
});

const leftText = JSON.stringify(Array.from({ length: 1500 }, (_, i) => `left ${i}`));
const rightText = JSON.stringify(Array.from({ length: 1500 }, (_, i) => `right ${i}`));
measure('text-1500-all-changed', () => makeTextDiff(leftText, rightText, '2'), (result) => {
  const changes = result.ops.reduce((count, op) => count + (op.type === 'same' ? 0 : op.count), 0);
  if (result.blocky || changes !== 3000) throw new Error('Expected exact diff of 3000 changed lines');
});

const equalText = JSON.stringify(rows);
measure('text-50k-equal', () => makeTextDiff(equalText, equalText, '2'), (result) => {
  if (result.blocky || result.ops.length !== 1 || result.ops[0].type !== 'same') {
    throw new Error('Expected one unchanged text range');
  }
});

const sparseLineCount = Number(process.env.TEXT_DIFF_BENCH_LINES || 250_000);
if (!Number.isSafeInteger(sparseLineCount) || sparseLineCount < 1) {
  throw new Error('TEXT_DIFF_BENCH_LINES must be a positive integer');
}
const sparseLeft = Array.from({ length: sparseLineCount }, (_, i) => `  "value": ${i % 10000},`).join('\n');
const sparseRight = Array.from({ length: sparseLineCount }, (_, i) =>
  `  "value": ${i % 11237 === 0 ? '999999' : i % 10000},`).join('\n');
const sparseChanges = Math.ceil(sparseLineCount / 11237);
measure(`text-${sparseLineCount}-sparse-lines`, () => diffFormattedText(sparseLeft, sparseRight), (result) => {
  const changes = result.ops.reduce((count, op) => count + (op.type === 'same' ? 0 : op.count), 0);
  if (result.blocky || changes !== sparseChanges * 2 || result.totalLines.some((n) => n !== sparseLineCount)) {
    throw new Error('Expected an exact diff preserving all scattered changes');
  }
});

const deepDepth = 20_000;
const deepPrefix = '{"child":'.repeat(deepDepth);
const deepSuffix = '}'.repeat(deepDepth);
const deepLeft = JSON.parse(deepPrefix + '0' + deepSuffix);
const deepRight = JSON.parse(deepPrefix + '1' + deepSuffix);
try {
  measure('structure-20k-deep', () => diffData(deepLeft, deepRight), (result) => {
    if (result.total !== 1 || result.diffs[0].leftPath !== '/child'.repeat(deepDepth)) {
      throw new Error('Expected one complete deep path');
    }
  });
} catch (error) {
  if (!(error instanceof RangeError)) throw error;
  // Allows the same benchmark to report stack overflow in older recursive versions.
  console.log(JSON.stringify({ name: 'structure-20k-deep', error: error.name + ': ' + error.message }));
}
