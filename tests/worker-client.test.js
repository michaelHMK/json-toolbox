import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskRunner } from '../src/shared/worker-client.js';

function setup(options = {}) {
  const busy = [];
  const requests = [];
  const workers = [];
  const resets = [];
  const makeWorker = () => ({
    terminated: false,
    postMessage: (message) => requests.push(message),
    terminate() { this.terminated = true; },
  });
  const worker = makeWorker();
  const run = createTaskRunner({
    ...options,
    createWorker() {
      const next = workers.length ? makeWorker() : worker;
      workers.push(next);
      return next;
    },
    onBusyChange: (value) => busy.push(value),
    onReset: () => resets.push(true),
  });
  return { run, worker, workers, busy, requests, resets };
}

test('out-of-order replies reach their callers and busy lasts until all replies arrive', async () => {
  const { run, worker, busy, requests } = setup();
  const first = run('parse', { text: '{}' });
  const second = run('search', { text: 'a' });
  worker.onmessage({ data: { id: 999, ok: true } });
  assert.deepEqual(busy, [true, true]);
  worker.onmessage({ data: { id: requests[1].id, ok: true, result: 'second' } });
  assert.equal((await second).result, 'second');
  assert.equal(busy.at(-1), true);
  worker.onmessage({ data: { id: requests[0].id, ok: true, result: 'first' } });
  assert.equal((await first).result, 'first');
  assert.equal(busy.at(-1), false);
});

test('worker failure settles pending requests and the next request creates a usable worker', async () => {
  const { run, worker, workers, busy, requests, resets } = setup();
  assert.equal(workers.length, 0, 'construction is lazy');
  const first = run('format', { text: '{}' });
  const second = run('parse', { text: '[]' });
  worker.onerror({ message: 'load failed', preventDefault() {} });
  for (const response of await Promise.all([first, second])) {
    assert.equal(response.ok, false);
    assert.equal(response.code, 'WORKER_FAILED');
    assert.equal(response.error, 'load failed');
  }
  assert.equal(worker.terminated, true);
  assert.equal(busy.at(-1), false);
  assert.equal(resets.length, 1);
  assert.equal(workers.length, 1, 'failure does not immediately construct a replacement');
  const next = run('parse', { text: '{"recovered":true}' });
  assert.equal(workers.length, 2);
  workers[1].onmessage({ data: { id: requests.at(-1).id, ok: true, result: { recovered: true } } });
  assert.deepEqual((await next).result, { recovered: true });
});

test('worker construction can be retried after a failure', async () => {
  let attempts = 0;
  const busy = [];
  const requests = [];
  const worker = { postMessage(request) { requests.push(request); }, terminate() {} };
  const run = createTaskRunner({
    createWorker() {
      if (++attempts === 1) throw new Error('cannot create');
      return worker;
    },
    onBusyChange(value) { busy.push(value); },
  });
  const failed = await run('parse');
  assert.equal(failed.error, 'cannot create');
  assert.equal(failed.code, 'WORKER_FAILED');
  assert.equal(busy.at(-1), false);
  assert.equal(attempts, 1);
  const retry = run('parse');
  assert.equal(attempts, 2);
  worker.onmessage({ data: { id: requests[0].id, ok: true, result: {} } });
  assert.equal((await retry).ok, true);
  assert.equal(busy.at(-1), false);
});

test('unreadable responses terminate the worker and allow recovery', async () => {
  const setupResult = setup();
  const pending = setupResult.run('parse');
  setupResult.worker.onmessageerror();
  assert.equal((await pending).ok, false);
  assert.equal(setupResult.busy.at(-1), false);
  assert.equal(setupResult.worker.terminated, true);
  const retry = setupResult.run('parse');
  setupResult.workers[1].onmessage({ data: { id: setupResult.requests.at(-1).id, ok: true } });
  assert.equal((await retry).ok, true);
});

test('postMessage failure only fails that request and clears busy', async () => {
  const { run, worker, busy } = setup();
  const postMessage = worker.postMessage;
  worker.postMessage = () => { throw new Error('cannot clone'); };
  assert.equal((await run('parse')).error, 'cannot clone');
  assert.equal(busy.at(-1), false);
  worker.postMessage = postMessage;
  const next = run('parse');
  worker.onmessage({ data: { id: 2, ok: true } });
  assert.equal((await next).ok, true);
});

test('serialized work replaces unsent requests without cloning stale inputs', async () => {
  const requests = [];
  const busy = [];
  const worker = { postMessage(request) { requests.push(request); }, terminate() {} };
  const run = createTaskRunner({ serialize: true, createWorker: () => worker, onBusyChange: (value) => busy.push(value) });
  const first = run('format', { text: 'first' }, { key: 'format' });
  const obsolete = run('format', { text: 'obsolete' }, { key: 'format' });
  const search = run('search', { text: 'needle' }, { key: 'search' });
  const latest = run('format', { text: 'latest' }, { key: 'format' });
  assert.equal((await obsolete).cancelled, true);
  assert.deepEqual(requests.map((request) => request.text), ['first']);
  worker.onmessage({ data: { id: requests[0].id, ok: true } });
  await first;
  assert.equal(requests[1].action, 'search', 'unrelated queued tasks preserve FIFO order');
  worker.onmessage({ data: { id: requests[1].id, ok: true } });
  await search;
  assert.equal(requests[2].text, 'latest');
  worker.onmessage({ data: { id: requests[2].id, ok: true } });
  await latest;
  assert.equal(busy.at(-1), false);
});

test('cancel terminates running work and settles active and queued requests immediately', async () => {
  const { run, worker, workers, requests, busy, resets } = setup({ serialize: true });
  const active = run('format');
  const queued = run('parse');
  assert.equal(run.cancel(), true);
  assert.equal(worker.terminated, true);
  assert.equal(busy.at(-1), false);
  assert.equal(resets.length, 1);
  assert.equal(workers.length, 1, 'cancel leaves worker recreation until a new task');
  const results = await Promise.all([active, queued]);
  assert.ok(results.every((result) => result.ok === false && result.cancelled === true));
  assert.deepEqual(requests.map((request) => request.action), ['format']);
  const next = run('parse');
  assert.equal(workers.length, 2);
  workers[1].onmessage({ data: { id: requests.at(-1).id, ok: true } });
  assert.equal((await next).ok, true);
});

test('clear terminates active work without posting or creating a worker', async () => {
  const { run, worker, workers, requests, busy } = setup({ serialize: true });
  assert.equal((await run('clear')).ok, true);
  assert.equal(workers.length, 0, 'clearing an unused runner does not create a worker');
  const active = run('format');
  const queued = run('parse');
  const clear = run('clear', {}, { discardQueued: true });
  assert.equal(worker.terminated, true);
  assert.equal(busy.at(-1), false);
  assert.equal(workers.length, 1);
  assert.deepEqual(requests.map((request) => request.action), ['format']);
  assert.equal((await active).cancelled, true);
  assert.equal((await queued).cancelled, true);
  assert.deepEqual((await clear).result, {});
  assert.equal((await run('clear')).ok, true);
  assert.equal(workers.length, 1, 'repeated clears remain lazy');
});

test('events from a terminated worker cannot settle or fail new requests', async () => {
  const { run, worker, workers, requests, busy, resets } = setup();
  const active = run('parse');
  run.cancel();
  assert.equal((await active).cancelled, true);
  const next = run('format');
  const id = requests.at(-1).id;
  worker.onmessage({ data: { id, ok: true, result: 'stale' } });
  worker.onerror({ message: 'late failure', preventDefault() {} });
  worker.onmessageerror();
  assert.equal(busy.at(-1), true);
  assert.equal(workers[1].terminated, false);
  assert.equal(resets.length, 1);
  workers[1].onmessage({ data: { id, ok: true, result: 'new' } });
  assert.equal((await next).result, 'new');
  assert.equal(busy.at(-1), false);
});

test('cancel onlyIfBusy preserves an idle worker and its cached data', async () => {
  const { run, worker, workers, requests, resets } = setup();
  assert.equal(run.cancel({ onlyIfBusy: true }), false);
  assert.equal(workers.length, 0);
  const parse = run('parse');
  worker.onmessage({ data: { id: requests[0].id, ok: true } });
  await parse;
  assert.equal(run.cancel({ onlyIfBusy: true }), false);
  assert.equal(worker.terminated, false);
  assert.equal(resets.length, 0);
  const search = run('search');
  assert.equal(run.cancel({ onlyIfBusy: true }), true);
  assert.equal((await search).cancelled, true);
  assert.equal(resets.length, 1);
});

test('worker failure settles serialized active and queued work without sending more', async () => {
  const requests = [];
  const worker = { postMessage(request) { requests.push(request); }, terminate() {} };
  const run = createTaskRunner({ serialize: true, createWorker: () => worker });
  const jobs = [run('format'), run('search')];
  worker.onerror({ message: 'failed', preventDefault() {} });
  assert.ok((await Promise.all(jobs)).every((result) => result.error === 'failed'));
  assert.equal(requests.length, 1);
});

test('partial tree batches keep serialized tasks pending until the final response', async () => {
  const { run, worker, busy, requests } = setup({ serialize: true });
  const first = run('parse');
  const second = run('search');
  const id = requests[0].id;
  worker.onmessage({ data: { id, treeChunk: [[-1, '', 2], [0, 'data', 2]] } });
  assert.equal(requests.length, 1);
  assert.equal(busy.at(-1), true);
  worker.onmessage({ data: { id, treeChunk: [[1, 'answer', 0, 42]] } });
  assert.equal(requests.length, 1);
  worker.onmessage({ data: { id, ok: true, result: { streamedData: true, snapshotId: 10 } } });
  assert.deepEqual((await first).result, { data: { answer: 42 }, snapshotId: 10 });
  assert.equal(requests.length, 2);
  worker.onmessage({ data: { id: requests[1].id, ok: true, result: {} } });
  await second;
  assert.equal(busy.at(-1), false);
});

test('interleaved tree batches belong to their own requests and cancellation drops partial data', async () => {
  const { run, worker, workers, requests } = setup();
  const first = run('parse');
  const second = run('parse');
  const [one, two] = requests.map((request) => request.id);
  worker.onmessage({ data: { id: one, treeChunk: [[-1, '', 2], [0, 'data', 0, 1]] } });
  worker.onmessage({ data: { id: two, treeChunk: [[-1, '', 2], [0, 'data', 0, 2]] } });
  worker.onmessage({ data: { id: two, ok: true, result: { streamedData: true } } });
  assert.equal((await second).result.data, 2);
  run.cancel();
  assert.equal((await first).cancelled, true);
  const next = run('parse');
  const id = requests.at(-1).id;
  worker.onmessage({ data: { id, ok: true, result: { streamedData: true } } });
  workers[1].onmessage({ data: { id, ok: true, result: { streamedData: true } } });
  assert.equal((await next).ok, false, 'new connections must not reuse partial data');
});
