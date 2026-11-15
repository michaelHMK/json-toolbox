import test from 'node:test';
import assert from 'node:assert/strict';
import { createComparisonSession } from '../src/shared/comparison-session.js';
import { createSessionWorker } from './helpers/session-worker.js';

const settle = () => new Promise(setImmediate);
function setup() {
  const worker = createSessionWorker();
  return { ...worker, session: createComparisonSession({ createRunner: worker.createRunner }) };
}

test('text-first comparison transfers data only on demand and deduplicates concurrent requests', async () => {
  const { session, workers, held } = setup();
  const compared = await session.compare({ text: '{"amount":1.20}', text2: '{"amount":2.30}', includeData: false });
  assert.equal(compared.ok, true);
  assert.equal(Object.hasOwn(compared.result, 'snapshotId'), false);
  assert.equal(compared.result.leftData, undefined);
  const comparison = compared.comparison;
  const text = await comparison.textDiff();
  assert.match(text.result.aText, /1\.20/);
  assert.match(text.result.bText, /2\.30/);
  assert.ok(!workers[0].requests.some((request) => request.action === 'comparisonData'));
  held.add('comparisonData');
  const first = comparison.ensureData();
  const second = comparison.ensureData();
  await settle();
  const requests = workers[0].requests.filter((request) => request.action === 'comparisonData');
  assert.equal(requests.length, 1);
  held.clear();
  workers[0].complete(requests[0]);
  const responses = await Promise.all([first, second]);
  for (const response of responses) {
    assert.equal(response.ok, true);
    assert.equal(response.result.leftData.amount, 1.2);
    assert.equal(response.result.leftNumberLiterals['/amount'], '1.20');
    assert.equal(Object.hasOwn(response.result, 'snapshotId'), false);
  }
  await comparison.ensureData();
  assert.equal(workers[0].requests.filter((request) => request.action === 'comparisonData').length, 1);
  session.clear();
});

test('both remote comparison trees share recovery with the completed comparison options', async () => {
  const { session, workers, held } = setup();
  const compared = await session.compare({
    text: '[{"id":1,"value":1,"ignored":0},{"id":2,"value":2}]',
    text2: '[{"id":2,"value":2},{"id":1,"value":3,"ignored":9}]',
    keyField: 'id', ignorePaths: ['ignored'], remote: true, includeData: false,
  });
  assert.equal(compared.ok, true);
  session.cancel();
  held.add('diff');
  const left = compared.comparison.requestTree('left', { options: { expandLevel: 3 }, count: 20 });
  const right = compared.comparison.requestTree('right', { options: { expandLevel: 3 }, count: 20 });
  await settle();
  assert.deepEqual(workers[1].requests.map((request) => request.action), ['diff']);
  const recovery = workers[1].requests[0];
  assert.equal(recovery.includeData, false);
  assert.equal(recovery.keyField, 'id');
  assert.deepEqual(recovery.ignorePaths, ['ignored']);
  held.clear();
  workers[1].complete(recovery);
  const windows = await Promise.all([left, right]);
  assert.equal(windows[0].result.rows.find((row) => row.path === '/0/id').value, 1);
  assert.equal(windows[1].result.rows.find((row) => row.path === '/0/id').value, 2);
  assert.equal(workers[1].requests.filter((request) => request.action === 'diff').length, 1);
  assert.equal(compared.result.leftData, undefined);
  session.clear();
});

test('a pending replacement blocks old snapshot work and success permanently revokes the old handle', async () => {
  const { session, workers, held } = setup();
  const old = await session.compare({ text: '{"old":1}', text2: '{"old":2}', includeData: false });
  held.add('diff');
  const pending = session.compare({ text: '{"fresh":3}', text2: '{"fresh":4}', includeData: false });
  assert.equal(session.pending, true);
  assert.equal((await old.comparison.ensureData()).cancelled, true);
  assert.equal((await old.comparison.textDiff()).cancelled, true);
  assert.deepEqual(workers[0].requests.map((request) => request.action), ['diff', 'diff']);
  held.clear();
  workers[0].complete(workers[0].requests.at(-1));
  const replacement = await pending;
  assert.equal((await old.comparison.requestTree('left', { options: {} })).cancelled, true);
  let applied = false;
  assert.equal(session.apply(old, () => { applied = true; }), false);
  assert.equal(applied, false);
  const text = await replacement.comparison.textDiff();
  assert.equal(JSON.parse(text.result.aText).fresh, 3);
  assert.equal(JSON.parse(text.result.bText).fresh, 4);
  session.clear();
  assert.equal((await replacement.comparison.ensureData()).cancelled, true);
  assert.equal(workers.length, 1);
});

test('cancellation after Worker completion but before comparison acceptance restores the previous pair', async () => {
  const { session, workers, held } = setup();
  const old = await session.compare({ text: '{"original":1}', text2: '{"original":2}', remote: true });
  held.add('diff');
  let notifications = 0;
  const pending = session.compare({ text: '{"replacement":3}', text2: '{"replacement":4}', remote: true }, () => { notifications++; });
  workers[0].complete(workers[0].requests.at(-1));
  queueMicrotask(() => session.cancel({ onlyIfBusy: true }));
  assert.equal((await pending).cancelled, true);
  assert.equal(notifications, 0);
  held.clear();
  const rows = await old.comparison.requestTree('left', { options: {} });
  assert.equal(rows.ok, true);
  assert.ok(rows.result.rows.some((row) => row.path === '/original' && row.value === 1));
  assert.ok(!rows.result.rows.some((row) => row.path === '/replacement'));
  session.clear();
});

test('comparison commits its displayed handle before a promise continuation can cancel it', async () => {
  const { session, workers, held } = setup();
  const old = await session.compare({ text: '{"original":1}', text2: '{"original":2}', remote: true });
  let displayed = old.comparison;
  const order = [];
  held.add('diff');
  const pending = session.compare({ text: '{"replacement":3}', text2: '{"replacement":4}', remote: true }, (response) => {
    assert.equal(response.ok, true);
    displayed = response.comparison;
    order.push('display');
  });
  const interrupted = pending.then(() => {
    order.push('cancel');
    session.cancel();
  });
  workers[0].complete(workers[0].requests.at(-1));
  await interrupted;
  assert.deepEqual(order, ['display', 'cancel']);
  assert.notStrictEqual(displayed, old.comparison);
  held.clear();
  const rows = await displayed.requestTree('left', { options: {} });
  assert.equal(rows.ok, true);
  assert.ok(rows.result.rows.some((row) => row.path === '/replacement' && row.value === 3));
  assert.equal((await old.comparison.ensureData()).cancelled, true);
  session.clear();
});

for (const ok of [true, false]) {
  test(`cancel rejects a late ${ok ? 'successful' : 'failed'} comparison even when the runner cannot cancel`, async () => {
    let finish;
    const run = () => new Promise((resolve) => { finish = resolve; });
    run.cancel = () => false;
    const session = createComparisonSession({ createRunner: () => run });
    let notifications = 0;
    const pending = session.compare({ text: '{"old":1}', text2: '{"old":2}' }, () => { notifications++; });
    session.cancel();
    finish(ok ? { ok: true, result: { total: 1, diffs: [], pairs: [], snapshotId: 1 } }
      : { ok: false, code: 'INVALID_JSON', error: 'late error' });
    const response = await pending;
    assert.equal(response.cancelled, true);
    assert.equal(notifications, 0);
    assert.equal(session.pending, false);
    let applied = false;
    assert.equal(session.apply(response, () => { applied = true; }), false);
    assert.equal(applied, false);
  });
}

test('Worker failure remains actionable and comparison can restart afterwards', async () => {
  const { session, workers, held } = setup();
  held.add('diff');
  let notified;
  const pending = session.compare({ text: '{"value":1}', text2: '{"value":2}' }, (response) => { notified = response; });
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
  const next = await session.compare({ text: '{"fresh":3}', text2: '{"fresh":4}' });
  assert.equal(next.ok, true);
  assert.equal(next.result.total, 1);
  session.clear();
});
