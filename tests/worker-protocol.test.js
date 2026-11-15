import test from 'node:test';
import assert from 'node:assert/strict';
import { postTaskResponse, decodeTaskResponse, createTaskResponseDecoder } from '../src/shared/worker-protocol.js';
import { createTaskHandler } from '../src/worker/tasks.js';
import { createTaskRunner } from '../src/shared/worker-client.js';

function transfer(handler, request, { rejectTree = true, rejectFallback = false } = {}) {
  const calls = [];
  const posted = [];
  let attempts = 0;
  postTaskResponse(request, (input) => {
    calls.push(input);
    return handler(input);
  }, (response) => {
    attempts++;
    if (rejectTree && response.result && (Object.hasOwn(response.result, 'data') || Object.hasOwn(response.result, 'leftData'))) {
      throw new RangeError('Maximum call stack size exceeded');
    }
    if (rejectFallback && response.treeChunk) throw new Error('Fallback transfer failed');
    posted.push(structuredClone(response));
  });
  const decode = createTaskResponseDecoder();
  const completed = posted.map((message) => decode(message)).filter(Boolean);
  assert.equal(completed.length, 1, 'every request should produce exactly one completed response');
  for (const message of posted) if (message.treeChunk) assert.ok(message.treeChunk.length <= 256);
  return { wire: posted.at(-1), decoded: completed[0], attempts, calls, posted };

}

const source = '{"2":2.00,"1":1E+02,"dup":{"old":1e9},"dup":3.00,"__proto__":4.00,"a/b":{"~":[9007199254740993,1e400,-0]},"s":"\\u4e2d\\/"}';

function assertFaithful(result, dataKey = 'data', literalsKey = 'numberLiterals') {
  assert.deepEqual(result[dataKey], JSON.parse(source));
  assert.deepEqual(Object.keys(result[dataKey]), ['1', '2', 'dup', '__proto__', 'a/b', 's']);
  assert.equal(result[dataKey].__proto__, 4);
  assert.equal(Object.is(result[dataKey]['a/b']['~'][2], -0), true);
  assert.equal(result[dataKey]['a/b']['~'][1], Infinity);
  assert.equal(result[literalsKey]['/dup/old'], undefined);
  assert.equal(result[literalsKey]['/dup'], '3.00');
  assert.equal(result[literalsKey]['/1'], '1E+02');
  assert.equal(result[literalsKey]['/a~1b/~0/0'], '9007199254740993');
  assert.equal(result[literalsKey]['/a~1b/~0/1'], '1e400');
  assert.equal(result[literalsKey]['/a~1b/~0/2'], '-0');
}

test('ordinary responses use native cloning without snapshot reads or main-thread parsing', (t) => {
  const handler = createTaskHandler();
  const result = transfer(handler, { id: 7, action: 'parse', text: source, retainSnapshot: true }, { rejectTree: false });
  assert.equal(result.attempts, 1);
  assert.equal(result.calls.length, 1);
  assert.equal(result.wire.ok, true);
  assert.equal(Object.hasOwn(result.wire.result, 'serializedData'), false);
  t.mock.method(JSON, 'parse', () => { throw new Error('Ordinary decode must not parse JSON'); });
  assert.strictEqual(decodeTaskResponse(result.wire), result.wire);
});

test('document transfer fallback preserves source semantics, literals and response metadata', () => {
  const handler = createTaskHandler();
  const { wire, decoded, attempts } = transfer(handler, { id: 8, action: 'parse', text: source, retainSnapshot: true });
  assert.equal(attempts, 3);
  assert.equal(wire.id, 8);
  assert.equal(wire.ok, true);
  assert.equal(Object.hasOwn(wire.result, 'data'), false);
  assert.equal(wire.result.streamedData, true);
  assert.equal(decoded.id, 8);
  assert.equal(decoded.duration, wire.duration);
  assert.equal(decoded.result.snapshotId, wire.result.snapshotId);
  assert.equal(Object.hasOwn(decoded.result, 'streamedData'), false);
  assertFaithful(decoded.result);
  assert.equal(wire.result.streamedData, true, 'decoding must not mutate the wire response');
});

test('parseSnapshot fallback uses request snapshot id and leaves search data intact', () => {
  const handler = createTaskHandler();
  const saved = handler({ action: 'format', text: source, includeData: false, retainSnapshot: true });
  assert.equal(saved.ok, true);
  const { wire, decoded } = transfer(handler, { id: 9, action: 'parseSnapshot', snapshotId: saved.result.snapshotId });
  assert.equal(Object.hasOwn(wire.result, 'snapshotId'), false);
  assert.equal(decoded.ok, true);
  assertFaithful(decoded.result);
  assert.equal(handler({ action: 'search', text: '中/' }).result.matchCount, 1);
  assert.equal(handler({ action: 'parseSnapshot', snapshotId: saved.result.snapshotId }).ok, true);
});

test('comparisonData fallback restores both sides without requiring a snapshot id in the result', () => {
  const handler = createTaskHandler();
  const right = source.replace('3.00', '5.00');
  const saved = handler({ action: 'diff', text: source, text2: right, includeData: false, retainSnapshot: true });
  assert.equal(saved.ok, true);
  const { wire, decoded } = transfer(handler, { id: 10, action: 'comparisonData', snapshotId: saved.result.snapshotId });
  assert.equal(Object.hasOwn(wire.result, 'snapshotId'), false);
  assert.equal(Object.hasOwn(wire.result, 'leftData'), false);
  assert.equal(Object.hasOwn(wire.result, 'rightData'), false);
  assert.equal(decoded.ok, true);
  assertFaithful(decoded.result, 'leftData', 'leftNumberLiterals');
  assert.deepEqual(decoded.result.rightData, JSON.parse(right));
  assert.equal(decoded.result.rightNumberLiterals['/dup'], '5.00');
});

test('diff fallback preserves changes and shares identical reconstructed sides', () => {
  const handler = createTaskHandler();
  const identical = transfer(handler, { id: 11, action: 'diff', text: source, text2: source, retainSnapshot: true });
  assert.equal(identical.decoded.result.total, 0);
  assert.strictEqual(identical.decoded.result.leftData, identical.decoded.result.rightData);
  const changed = transfer(handler, { id: 12, action: 'diff', text: source, text2: source.replace('3.00', '5.00'), retainSnapshot: true });
  assert.equal(changed.decoded.result.total, 1);
  assert.equal(changed.decoded.result.diffs[0].leftPreview, '3.00');
  assert.equal(changed.decoded.result.diffs[0].rightPreview, '5.00');
  assert.deepEqual(changed.decoded.result.stats, { added: 0, removed: 0, changed: 1, typeChanged: 0 });
});

test('bounded fallback reconstructs 20,000 levels without parsing source on the main thread', (t) => {
  const depth = 20_000;
  const text = '{"child":'.repeat(depth) + '{"value":1.2300}' + '}'.repeat(depth);
  const request = { id: 13, action: 'parse', text, retainSnapshot: true };
  const response = createTaskHandler()(request);
  t.mock.method(JSON, 'parse', () => { throw new Error('Main thread must not parse JSON'); });
  const { decoded, posted } = transfer(() => response, request);
  assert.ok(posted.length > 70, 'deep trees are split into bounded messages');
  assert.equal(decoded.ok, true);
  let value = decoded.result.data;
  for (let i = 0; i < depth; i++) value = value.child;
  assert.equal(value.value, 1.23);
  assert.equal(decoded.result.numberLiterals['/child'.repeat(depth) + '/value'], '1.2300');
});

test('missing, stale and mismatched snapshot ids fail without exposing a replacement snapshot', () => {
  const handler = createTaskHandler();
  const previous = handler({ action: 'parse', text: '{"old":true}', retainSnapshot: true });
  const current = handler({ action: 'parse', text: '{"current":true}', retainSnapshot: true });
  for (const request of [
    { action: 'parseSnapshot' },
    { action: 'parseSnapshot', snapshotId: previous.result.snapshotId },
    { action: 'comparisonData', snapshotId: current.result.snapshotId },
    { action: 'snapshotText', kind: 'document' },
    { action: 'snapshotText', kind: 'document', snapshotId: previous.result.snapshotId },
  ]) {
    const { wire, calls, attempts } = transfer(handler, { id: 14, ...request });
    assert.equal(wire.ok, false);
    assert.match(wire.error, /snapshot.*available/i);
    assert.equal(attempts, 1);
    assert.equal(calls.length, 1);
    assert.equal(Object.hasOwn(wire, 'result'), false);
  }
  assert.deepEqual(handler({ action: 'snapshotText', kind: 'document', snapshotId: current.result.snapshotId }).result, { data: '{"current":true}' });
});

test('fallback uses the exact result without a retained or still-current snapshot', () => {
  const handler = createTaskHandler();
  const calls = [];
  const messages = [];
  const request = { id: 15, action: 'parse', text: source };
  postTaskResponse(request, (input) => { calls.push(input); return handler(input); }, (response) => {
    if (response.result?.data) {
      handler({ action: 'clear' });
      throw new RangeError('Cannot transfer tree');
    }
    messages.push(response);
  });
  const decode = createTaskResponseDecoder();
  const completed = messages.map(decode).filter(Boolean);
  assert.equal(calls.length, 1, 'fallback does not reread a mutable snapshot');
  assert.equal(completed.length, 1);
  assertFaithful(completed[0].result);
  assert.equal(handler({ action: 'parse', text: '{"alive":true}' }).ok, true);
});

test('failed fallback transfer returns a single task error and leaves the Worker usable', () => {
  const handler = createTaskHandler();
  const failedFallback = transfer(handler, { id: 17, action: 'parse', text: source, retainSnapshot: true }, { rejectFallback: true });
  assert.equal(failedFallback.decoded.ok, false);
  assert.equal(failedFallback.decoded.error, 'Fallback transfer failed');
  assert.equal(failedFallback.attempts, 3);
  assert.equal(handler({ action: 'parse', text: '{"alive":true}' }).ok, true);
});

test('transfer errors on results without data never try to recover an unrelated snapshot', () => {
  const handler = createTaskHandler();
  handler({ action: 'parse', text: source, retainSnapshot: true });
  const calls = [];
  const messages = [];
  postTaskResponse({ id: 18, action: 'search', text: 'missing' }, (request) => {
    calls.push(request);
    return handler(request);
  }, (response) => {
    if (response.ok) throw new Error('Response transfer failed');
    messages.push(response);
  });
  assert.equal(calls.length, 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ok, false);
  assert.equal(messages[0].error, 'Response transfer failed');
  assert.equal(handler({ action: 'search', text: '中/' }).result.matchCount, 1);
});

test('missing chunks become a task error and failures release partial transfers', () => {
  const decode = createTaskResponseDecoder();
  const response = { id: 19, ok: true, duration: 12, result: { streamedData: true } };
  const decoded = decode(response);
  assert.equal(decoded.id, 19);
  assert.equal(decoded.ok, false);
  assert.equal(decoded.duration, 12);
  assert.match(decoded.error, /Incomplete/);
  assert.equal(decode({ id: 20, treeChunk: [[-1, '', 2], [0, 'data', 2]] }), null);
  const failure = { id: 20, ok: false, error: 'Worker error' };
  assert.strictEqual(decode(failure), failure);
  assert.equal(decode({ id: 20, ok: true, result: { streamedData: true } }).ok, false);
});

test('client queue continues after fallback success and unrecoverable response-transfer errors', async () => {
  const handler = createTaskHandler();
  const busy = [];
  const worker = {
    terminated: false,
    terminate() { this.terminated = true; },
    postMessage(request) {
      queueMicrotask(() => postTaskResponse(request, handler, (response) => {
        if (response.result?.data?.failTransfer) throw new RangeError('Cannot transfer this tree');
        if (response.treeChunk && request.text.includes('rejectChunks')) throw new Error('Chunks rejected');
        this.onmessage({ data: structuredClone(response) });
      }));
    },
  };
  const run = createTaskRunner({ createWorker: () => worker, serialize: true, onBusyChange: (value) => busy.push(value) });
  const restored = run('parse', { text: '{"failTransfer":true}', retainSnapshot: true });
  const rejected = run('parse', { text: '{"failTransfer":true,"rejectChunks":true}' });
  const next = run('parse', { text: '{"alive":true}' });
  assert.deepEqual((await restored).result.data, { failTransfer: true });
  assert.equal((await rejected).ok, false);
  assert.deepEqual((await next).result.data, { alive: true });
  assert.equal(worker.terminated, false);
  assert.equal(busy.at(-1), false);
});
