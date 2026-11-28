import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentSession } from '../src/shared/document-session.js';
import { createSessionWorker } from './helpers/session-worker.js';

const settle = () => new Promise(setImmediate);
function setup() {
  const worker = createSessionWorker();
  return { ...worker, session: createDocumentSession({ createRunner: worker.createRunner }) };
}

test('document windows and search share one recovery without transferring the object graph', async () => {
  const { session, workers, held } = setup();
  const parsed = await session.parse('{"amount":1.20,"nested":{"value":"needle"}}');
  assert.equal(parsed.ok, true);
  assert.equal(Object.hasOwn(parsed.result, 'snapshotId'), false);
  assert.equal(Object.hasOwn(parsed.result, 'data'), false);
  const document = parsed.document;
  assert.equal(document.ready, true);
  workers[0].crash();
  held.add('parse');
  const window = document.requestTree({ options: { expandLevel: 3 }, count: 20 });
  const search = document.search('needle');
  await settle();
  assert.deepEqual(workers[1].requests.map((request) => request.action), ['parse']);
  held.clear();
  workers[1].complete(workers[1].requests[0]);
  const [rows, matches] = await Promise.all([window, search]);
  assert.equal(rows.ok, true);
  assert.equal(rows.result.rows.find((row) => row.path === '/amount').literal, '1.20');
  assert.equal(matches.result.matchCount, 1);
  assert.equal(workers[1].requests.filter((request) => request.action === 'parse').length, 1);
  session.clear();
});

test('opening formatted output reuses its Worker snapshot without extra parsing or object transfer', async () => {
  const { session, workers } = setup();
  const formatted = await session.format('{"items":[1.20,2.30]}');
  assert.equal(formatted.document.ready, true);
  assert.equal(Object.hasOwn(formatted.result, 'data'), false);
  const parsed = await session.parse(formatted.result.text);
  assert.equal(parsed.ok, true);
  assert.strictEqual(parsed.document, formatted.document);
  assert.deepEqual(workers[0].requests.map((request) => request.action), ['format']);
  const window = await parsed.document.requestTree({ options: { expandLevel: 3 }, count: 20 });
  assert.equal(window.ok, true);
  assert.equal(window.result.rows.find((row) => row.path === '/items/0').literal, '1.20');
  assert.equal(window.result.rows.find((row) => row.path === '/items/1').literal, '2.30');
  session.clear();
});

for (const outcome of ['cancelled', 'invalid']) {
  test(`the displayed document survives a ${outcome} replacement and cannot restore during it`, async () => {
    const { session, workers, held } = setup();
    const previous = await session.format('{"original":{"value":1}}', { retainSnapshot: true });
    const document = previous.document;
    held.add('format');
    const replacement = session.format(outcome === 'invalid' ? '{' : '{"replacement":2}', { retainSnapshot: true });
    assert.equal(session.pending, true);
    const blocked = await document.requestTree({ options: {}, count: 20 });
    assert.equal(blocked.cancelled, true);
    assert.equal(workers[0].requests.filter((request) => request.action === 'parse').length, 0);
    if (outcome === 'cancelled') session.cancel();
    else workers[0].complete(workers[0].requests.at(-1));
    const result = await replacement;
    assert.equal(result.ok, false);
    assert.equal(session.pending, false);
    held.clear();
    const rows = await document.requestTree({ options: { expandLevel: 3 }, count: 20 });
    assert.equal(rows.ok, true);
    assert.ok(rows.result.rows.some((row) => row.path === '/original/value'));
    assert.ok(!rows.result.rows.some((row) => row.path === '/replacement'));
    if (outcome === 'cancelled') {
      assert.equal(workers[1].requests[0].action, 'parse');
      assert.match(workers[1].requests[0].text, /original/);
    }
    session.clear();
  });
}

test('replacement and clear revoke old document handles without issuing more Worker work', async () => {
  const { session, workers } = setup();
  const first = await session.parse('{"old":1}');
  const second = await session.parse('{"fresh":2}');
  const freshRows = await second.document.requestTree({ options: {} });
  assert.equal(freshRows.result.rows.find((row) => row.path === '/fresh').value, 2);
  const count = workers[0].requests.length;
  for (const pending of [first.document.ensureSnapshot(), first.document.search('old'), first.document.requestTree({ options: {} })]) {
    assert.equal((await pending).cancelled, true);
  }
  assert.equal(workers[0].requests.length, count);
  let applied = false;
  session.apply(first, () => { applied = true; });
  assert.equal(applied, false);
  session.clear();
  assert.equal((await second.document.ensureSnapshot()).cancelled, true);
  assert.equal(workers.length, 1, 'cleared handles cannot recreate the Worker');
});

test('an old tree handle cannot restore its source while a replacement parse owns the Worker', async () => {
  const { session, workers, held } = setup();
  const old = await session.parse('{"old":1}');
  session.cancel();
  held.add('parse');
  const pending = session.parse('{"fresh":2}');
  const staleTree = old.document.requestTree({ options: {} });
  await settle();
  held.clear();
  workers[1].complete(workers[1].requests[0]);
  const next = await pending;
  assert.equal((await staleTree).cancelled, true);
  const rows = await next.document.requestTree({ options: {} });
  assert.equal(rows.ok, true);
  assert.ok(rows.result.rows.some((row) => row.path === '/fresh' && row.value === 2));
  assert.ok(!workers[1].requests.some((request) => request.action === 'parse' && request.text.includes('old')));
  session.clear();
});

for (const action of ['format', 'parse']) {
  test(`cancelling after Worker ${action} completes but before its continuation recovers the displayed source`, async () => {
    const { session, workers, held } = setup();
    const old = await session.parse('{"original":1}');
    held.add(action);
    let notifications = 0;
    const onResult = () => { notifications++; };
    const pending = action === 'format'
      ? session.format('{"replacement":2}', { retainSnapshot: true }, onResult)
      : session.parse('{"replacement":2}', onResult);
    workers[0].complete(workers[0].requests.at(-1));
    queueMicrotask(() => session.cancel({ onlyIfBusy: true }));
    assert.equal((await pending).cancelled, true);
    assert.equal(notifications, 0, 'an obsolete operation cannot commit displayed state');
    held.clear();
    const rows = await old.document.requestTree({ options: {} });
    assert.equal(rows.ok, true);
    assert.ok(rows.result.rows.some((row) => row.path === '/original' && row.value === 1));
    assert.ok(!rows.result.rows.some((row) => row.path === '/replacement'));
    session.clear();
  });
}

for (const action of ['format', 'parse']) {
  test(`${action} commits the displayed handle before a promise continuation can cancel it`, async () => {
    const { session, workers, held } = setup();
    const old = await session.parse('{"original":1}');
    let displayed = old.document;
    const order = [];
    held.add(action);
    const onResult = (response) => {
      assert.equal(response.ok, true);
      displayed = response.document;
      order.push('display');
    };
    const pending = action === 'format'
      ? session.format('{"replacement":2}', { retainSnapshot: true }, onResult)
      : session.parse('{"replacement":2}', onResult);
    const interrupted = pending.then(() => {
      order.push('cancel');
      session.cancel();
    });
    workers[0].complete(workers[0].requests.at(-1));
    await interrupted;
    assert.deepEqual(order, ['display', 'cancel']);
    assert.notStrictEqual(displayed, old.document);
    held.clear();
    const rows = await displayed.requestTree({ options: {} });
    assert.equal(rows.ok, true);
    assert.ok(rows.result.rows.some((row) => row.path === '/replacement' && row.value === 2));
    assert.equal((await old.document.ensureSnapshot()).cancelled, true);
    session.clear();
  });
}

for (const ok of [true, false]) {
  test(`cancel rejects a late ${ok ? 'successful' : 'failed'} format even when the runner cannot cancel`, async () => {
    let finish;
    const run = () => new Promise((resolve) => { finish = resolve; });
    run.cancel = () => false;
    const session = createDocumentSession({ createRunner: () => run });
    let notifications = 0;
    const pending = session.format('{"late":1}', {}, () => { notifications++; });
    session.cancel();
    finish(ok ? { ok: true, result: { text: '{"late":1}', snapshotId: 1 } }
      : { ok: false, code: 'INVALID_JSON', error: 'late error' });
    const response = await pending;
    assert.equal(response.cancelled, true);
    assert.equal(notifications, 0);
    assert.equal(session.pending, false);
    let applied = false;
    session.apply(response, () => { applied = true; });
    assert.equal(applied, false);
  });
}

test('Worker failure remains an actionable error and the next format can succeed', async () => {
  const { session, workers, held } = setup();
  held.add('format');
  let notified;
  const pending = session.format('{"value":1}', {}, (response) => { notified = response; });
  workers[0].crash();
  const failed = await pending;
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'WORKER_FAILED');
  assert.notEqual(failed.cancelled, true);
  assert.equal(notified.code, 'WORKER_FAILED');
  let reported;
  session.apply(failed, () => { reported = failed.error; });
  assert.equal(reported, 'test worker crash');
  held.clear();
  const next = await session.format('{"fresh":2}');
  assert.equal(next.ok, true);
  assert.match(next.result.text, /fresh/);
  session.clear();
});

test('Worker failure during an initial parse is reported and leaves parsing retryable', async () => {
  const { session, workers, held } = setup();
  held.add('parse');
  let notified;
  const pending = session.parse('{"value":1}', (response) => { notified = response; });
  workers[0].crash();
  const failed = await pending;
  assert.equal(failed.code, 'WORKER_FAILED');
  assert.notEqual(failed.cancelled, true);
  assert.equal(notified.code, 'WORKER_FAILED');
  let reported = false;
  session.apply(failed, () => { reported = true; });
  assert.equal(reported, true);
  held.clear();
  const retried = await session.parse('{"value":1}');
  assert.equal(retried.ok, true);
  const rows = await retried.document.requestTree({ options: {} });
  assert.equal(rows.result.rows.find((row) => row.path === '/value').value, 1);
  session.clear();
});

test('query invalidation suppresses an already completed search before UI application', async () => {
  const { session } = setup();
  const parsed = await session.parse('{"value":"needle"}');
  const previous = await parsed.document.search('needle');
  assert.equal(previous.result.matchCount, 1);
  session.invalidateSearch();
  let applied = false;
  session.apply(previous, () => { applied = true; });
  assert.equal(applied, false);
  const latest = await parsed.document.search('absent');
  session.apply(latest, () => { applied = true; });
  assert.equal(applied, true);
  assert.equal(latest.result.matchCount, 0);
  session.clear();
});

test('document-session does not reuse leniently cached document for strict parse and forwards includeTextIndex', async () => {
  const { session } = setup();
  const lenientText = '{a: 1}';
  const first = await session.parse(lenientText, undefined, { strict: false });
  assert.equal(first.ok, true);
  assert.equal(first.result.lenient, true);

  const second = await session.parse(lenientText, undefined, { strict: true });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'INVALID_JSON');

  const largeStrict = '[' + '1,'.repeat(140 * 1024) + '2]';
  const third = await session.parse(largeStrict, undefined, { strict: true, includeTextIndex: true });
  assert.equal(third.ok, true);
  assert.ok(third.result.lineIndex);
  const cached = await session.parse(largeStrict, undefined, { strict: true, includeTextIndex: true });
  assert.equal(cached.ok, true);
  assert.ok(cached.result.lineIndex);
  session.clear();
});
