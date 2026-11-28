import test from 'node:test';
import assert from 'node:assert/strict';
import { postTaskResponse } from '../src/shared/worker-protocol.js';
import { createTaskHandler } from '../src/worker/tasks.js';
import { createTaskRunner } from '../src/shared/worker-client.js';

function send(handler, request, { onPost } = {}) {
  const posted = [];
  postTaskResponse(request, handler, (response, transfer) => {
    onPost?.(response, transfer);
    posted.push({ response: structuredClone(response), transfer });
  });
  assert.equal(posted.length, 1, 'every request should produce exactly one response');
  return posted[0];
}

const source = '{"2":2.00,"1":1E+02,"dup":{"old":1e9},"dup":3.00,"__proto__":4.00,"a/b":{"~":[9007199254740993,1e400,-0]},"s":"\\u4e2d\\/"}';

test('Worker responses never transfer parsed object graphs and pass directly through structuredClone', () => {
  const handler = createTaskHandler();
  const formatted = send(handler, { id: 1, action: 'format', text: source, retainSnapshot: true }).response;
  assert.equal(formatted.ok, true);
  assert.equal(Object.hasOwn(formatted.result, 'data'), false);
  assert.equal(Object.hasOwn(formatted.result, 'numberLiterals'), false);
  assert.ok(Number.isInteger(formatted.result.snapshotId));

  const parsed = send(handler, { id: 2, action: 'parse', text: source, retainSnapshot: true }).response;
  assert.equal(parsed.ok, true);
  assert.deepEqual(Object.keys(parsed.result), ['snapshotId', 'lenient']);

  const diffed = send(handler, {
    id: 3, action: 'diff', text: source, text2: source.replace('3.00', '5.00'), retainSnapshot: true,
  }).response;
  assert.equal(diffed.ok, true);
  for (const key of ['leftData', 'rightData', 'leftNumberLiterals', 'rightNumberLiterals']) {
    assert.equal(Object.hasOwn(diffed.result, key), false);
  }
  assert.equal(diffed.result.total, 1);
});

test('deep JSON transfers snapshots, diffs and deep tree windows directly via structuredClone', () => {
  const depth = 20_000;
  const text = '{"child":'.repeat(depth) + '{"value":1.2300}' + '}'.repeat(depth);
  const text2 = '{"child":'.repeat(depth) + '{"value":4.5600}' + '}'.repeat(depth);
  const handler = createTaskHandler();
  const parsed = send(handler, { id: 10, action: 'parse', text, retainSnapshot: true }).response;
  assert.equal(parsed.ok, true);
  const diffed = send(handler, {
    id: 11, action: 'diff', text, text2, retainSnapshot: true, includePreviews: false,
  }).response;
  assert.equal(diffed.ok, true);
  assert.equal(diffed.result.total, 1);
  assert.equal(diffed.result.diffs[0].leftPath, '/child'.repeat(depth) + '/value');

  // Exceeds V8 structuredClone stack depth while keeping tree reveal fast in Node tests.
  const treeDepth = 3_500;
  const deepTree = '{"child":'.repeat(treeDepth) + '{"value":1.2300}' + '}'.repeat(treeDepth);
  const treeParsed = send(handler, { id: 12, action: 'parse', text: deepTree, retainSnapshot: true }).response;
  const leafPath = '/child'.repeat(treeDepth) + '/value';
  const revealed = send(handler, {
    id: 13, action: 'tree', operation: 'reveal', kind: 'document',
    snapshotId: treeParsed.result.snapshotId, options: {}, path: leafPath, count: 20,
  }).response;
  assert.equal(revealed.ok, true);
  assert.equal(revealed.result.activePath, leafPath);
  assert.equal(revealed.result.activeRow.literal, '1.2300');
  assert.ok(revealed.result.rows.length <= 20);
});

test('postMessage transfer errors return a single TASK_FAILED response and leave the Worker usable', () => {
  const handler = createTaskHandler();
  handler({ action: 'parse', text: source, retainSnapshot: true });
  const messages = [];
  postTaskResponse({ id: 18, action: 'search', text: 'missing' }, handler, (response) => {
    if (response.ok) throw new Error('Response transfer failed');
    messages.push(response);
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 18);
  assert.equal(messages[0].ok, false);
  assert.equal(messages[0].code, 'TASK_FAILED');
  assert.equal(messages[0].error, 'Response transfer failed');
  assert.equal(handler({ action: 'search', text: '中/' }).result.matchCount, 1);
});

test('large uncached text indexes are passed in the transferable list without detaching cached textDiff', () => {
  const handler = createTaskHandler();
  const large = '[' + '1,'.repeat(140000) + '2]';
  let transfers = null;
  postTaskResponse({ id: 22, action: 'format', text: large, includeTextIndex: true }, handler, (response, transfer) => {
    transfers = transfer;
    assert.ok(response.result.lineIndex.starts instanceof Uint32Array);
  });
  assert.equal(transfers?.length, 1);
  assert.ok(transfers[0] instanceof ArrayBuffer);

  let diffTransfers = null;
  postTaskResponse({ id: 23, action: 'textDiff', text: large, text2: large.replace('2]', '3]'), includeTextIndex: true }, handler, (response, transfer) => {
    diffTransfers = transfer;
    assert.ok(response.result.aLineIndex.starts instanceof Uint32Array);
    assert.ok(response.result.bLineIndex.starts instanceof Uint32Array);
  });
  assert.equal(diffTransfers?.length, 2);

  // Cached snapshot textDiff must not transfer buffers that a subsequent read could reuse.
  const diff = handler({ id: 24, action: 'diff', text: large, text2: large.replace('2]', '3]'), retainSnapshot: true });
  let cachedTransfers;
  postTaskResponse({ id: 25, action: 'textDiff', snapshotId: diff.result.snapshotId, includeTextIndex: true }, handler, (_response, transfer) => {
    cachedTransfers = transfer;
  });
  assert.equal(cachedTransfers, undefined);
});

test('client queue continues after an unrecoverable response-transfer error', async () => {
  const handler = createTaskHandler();
  const busy = [];
  const worker = {
    terminated: false,
    terminate() { this.terminated = true; },
    postMessage(request) {
      queueMicrotask(() => postTaskResponse(request, handler, (response) => {
        if (response.ok && request.text?.includes('failTransfer')) throw new Error('Response rejected');
        this.onmessage({ data: structuredClone(response) });
      }));
    },
  };
  const run = createTaskRunner({ createWorker: () => worker, serialize: true, onBusyChange: (value) => busy.push(value) });
  const rejected = run('format', { text: '{"failTransfer":true}' });
  const next = run('format', { text: '{"alive":true}' });
  const failed = await rejected;
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'TASK_FAILED');
  assert.match((await next).result.text, /"alive": true/);
  assert.equal(worker.terminated, false);
  assert.equal(busy.at(-1), false);
});
