import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskHandler } from '../src/worker/tasks.js';
import { loadPage } from './helpers/page-dom.js';

const settle = () => new Promise(setImmediate);

function loadCompare(runTask) {
  const handler = createTaskHandler();
  return loadPage('compare', {
    runTask: runTask || (async (action, payload) => handler({ action, ...payload })),
    expose: '{ state, doCompare, doClear, setCompareView, goToDiff, treeViews }',
  });
}

function visiblePaths(page, side = 'left') {
  return page.get('tree-' + side).querySelectorAll('.entry').map((entry) => entry.dataset.path);
}

function setInputs(page, left = '{"before":1}', right = '{"after":2}') {
  page.get('input-left').value = left;
  page.get('input-right').value = right;
}

function assertCleared(page) {
  for (const name of ['diffMap', 'expanded', 'collapsed']) {
    assert.equal(page.state[name].left.size, 0, name + '.left');
    assert.equal(page.state[name].right.size, 0, name + '.right');
  }
  for (const name of ['pairLR', 'pairRL']) assert.equal(page.state[name].size, 0, name);
  for (const name of ['result', 'textResult']) {
    assert.equal(page.state[name], null, name);
  }
  assert.equal(page.get('tree-left').children.length, 0);
  assert.equal(page.get('tree-right').children.length, 0);
  assert.equal(page.get('text-view').children.length, 0);
  assert.equal(page.get('result').hidden, true);
}

test('clear removes comparison DOM, data and every retained path/pair index', async () => {
  const page = loadCompare();
  page.get('array-mode').value = 'key';
  page.get('key-field').value = 'id';
  setInputs(page, '[{"id":1,"value":1},{"id":2,"value":2}]', '[{"id":2,"value":3},{"id":1,"value":4}]');
  await page.doCompare();
  assert.ok(page.get('tree-left').querySelectorAll('.entry').length > 0);
  assert.ok(page.state.diffMap.left.size > 0);
  assert.ok(page.state.pairLR.size > 0);
  await page.setCompareView('text');
  page.doClear();
  assertCleared(page);
});

test('clear discards an outstanding structural comparison response', async () => {
  let finish;
  const handler = createTaskHandler();
  const page = loadCompare((action, payload) => action === 'clear'
    ? Promise.resolve(handler({ action, ...payload })) : new Promise((resolve) => {
    finish = () => resolve(handler({ action, ...payload }));
  }));
  setInputs(page);
  const pending = page.doCompare();
  page.doClear();
  finish();
  await pending;
  assertCleared(page);
});

test('text diff uses the completed comparison snapshot even after input edits', async () => {
  const handler = createTaskHandler();
  const requests = [];
  let completedSnapshotId;
  const page = loadCompare(async (action, payload) => {
    requests.push({ action, ...payload });
    const response = handler({ action, ...payload });
    if (action === 'diff') completedSnapshotId = response.result.snapshotId;
    return response;
  });
  const left = '{"old":1}';
  const right = '{"old":2}';
  setInputs(page, left, right);
  await page.doCompare();
  setInputs(page, '{"unsaved":10}', '{"unsaved":20}');
  await page.setCompareView('text');
  const request = requests.find((request) => request.action === 'textDiff');
  assert.ok(Number.isInteger(completedSnapshotId));
  assert.equal(request.snapshotId, completedSnapshotId);
  assert.equal(request.text, undefined, 'snapshot requests do not resend input');
  assert.equal(request.text2, undefined);
  assert.equal(JSON.parse(page.state.textResult.aText).old, 1);
  assert.equal(JSON.parse(page.state.textResult.bText).old, 2);
});

test('text-only comparisons defer tree windows and all tree indexes until structure is opened', async () => {
  const handler = createTaskHandler();
  const requests = [];
  const page = loadCompare(async (action, payload) => {
    requests.push({ action, ...payload });
    return handler({ action, ...payload });
  });
  await page.setCompareView('text');
  page.get('array-mode').value = 'key';
  page.get('key-field').value = 'id';
  setInputs(page, '[{"id":1,"value":1},{"id":2,"value":2}]', '[{"id":2,"value":3},{"id":1,"value":4}]');
  await page.doCompare();
  assert.ok(page.state.textResult);
  assert.equal(page.state.indexesReady, false);
  assert.equal(page.state.pairLR.size, 0);
  assert.equal(page.state.diffMap.left.size, 0);
  assert.ok(!requests.some((request) => request.action === 'tree'));
  await page.setCompareView('struct');
  assert.equal(page.state.indexesReady, true);
  assert.equal(page.state.pairLR.size, 2);
  assert.ok(page.state.diffMap.left.size > 0);
  assert.equal(requests.filter((request) => request.action === 'diff').length, 1);
  const treeCount = requests.filter((request) => request.action === 'tree').length;
  assert.ok(treeCount >= 2);
  await page.setCompareView('text');
  await page.setCompareView('struct');
  assert.equal(requests.filter((request) => request.action === 'diff').length, 1);
  assert.equal(requests.filter((request) => request.action === 'tree').length, treeCount);
});

test('clear discards an outstanding text diff response', async () => {
  const handler = createTaskHandler();
  let finish;
  const page = loadCompare((action, payload) => action === 'textDiff'
    ? new Promise((resolve) => { finish = () => resolve(handler({ action, ...payload })); })
    : Promise.resolve(handler({ action, ...payload })));
  setInputs(page);
  await page.doCompare();
  const pending = page.setCompareView('text');
  page.doClear();
  finish();
  await pending;
  assertCleared(page);
});

test('a comparison made in text view builds its own structure when switching back', async () => {
  const page = loadCompare();
  setInputs(page);
  await page.doCompare();
  await page.setCompareView('text');
  setInputs(page, '{"fresh":3}', '{"fresh":4}');
  await page.doCompare();
  assert.equal(page.get('tree-left').children.length, 0, 'hidden old DOM must release references');
  await page.setCompareView('struct');
  assert.ok(visiblePaths(page).includes('/fresh'));
  assert.ok(!visiblePaths(page).includes('/before'));
  assert.equal(page.get('tree-left').querySelector('.v').textContent, '3');
});

test('only-differences changes made in text view apply when switching to structure', async () => {
  const page = loadCompare();
  setInputs(page, '{"stable":1,"changed":2}', '{"stable":1,"changed":3}');
  await page.doCompare();
  assert.ok(visiblePaths(page).includes('/stable'));
  await page.setCompareView('text');
  page.get('only-diff').checked = true;
  page.get('only-diff').events.change();
  await page.setCompareView('struct');
  assert.ok(!visiblePaths(page).includes('/stable'));
  assert.ok(visiblePaths(page).includes('/changed'));
});

test('transform clear releases cache and rejects stale successful or failed results', async () => {
  for (const ok of [true, false]) {
    let finish;
    const actions = [];
    const page = loadPage('transform', {
      bodyDataset: { action: 'minify' },
      expose: '{ runTransform, doClear, getOutputText: () => outputText }',
      runTask(action) {
        actions.push(action);
        return action === 'clear' ? Promise.resolve({ ok: true })
          : new Promise((resolve) => { finish = resolve; });
      },
    });
    page.get('input').value = '{"old":1}';
    const pending = page.runTransform();
    page.doClear();
    finish(ok ? { ok: true, result: { text: '{"old":1}' } } : { ok: false, error: 'old error' });
    await pending;
    assert.deepEqual(actions, ['minify', 'clear']);
    assert.equal(page.getOutputText(), '');
    assert.equal(page.get('output-text').textContent, '');
    assert.equal(page.get('error').hidden, true);
  }
});

test('switching views during comparison does not request the old snapshot', async () => {
  const handler = createTaskHandler();
  let hold = false;
  const requests = [];
  const page = loadCompare((action, payload) => {
    if (!hold) return Promise.resolve(handler({ action, ...payload }));
    return new Promise((resolve) => {
      requests.push({ action, finish: () => resolve(handler({ action, ...payload })) });
    });
  });
  setInputs(page, '{"snapshot":"A"}', '{"snapshot":"A2"}');
  await page.doCompare();
  hold = true;
  setInputs(page, '{"snapshot":"B"}', '{"snapshot":"B2"}');
  const comparePending = page.doCompare();
  const oldTextPending = page.setCompareView('text');
  await page.setCompareView('struct');
  assert.deepEqual(requests.map((request) => request.action), ['diff']);
  hold = false;
  requests[0].finish();
  await comparePending;
  await oldTextPending;
  assert.equal(page.state.textResult, null, 'text for A must not be cached against result B');
  await page.setCompareView('text');
  assert.equal(JSON.parse(page.state.textResult.aText).snapshot, 'B');
  assert.equal(JSON.parse(page.state.textResult.bText).snapshot, 'B2');
});

test('dense differences remain navigable on both sides with a bounded DOM', async () => {
  const page = loadCompare();
  const left = Array.from({ length: 5000 }, (_, id) => ({ id, changed: 1, stable: 0 }));
  const right = left.map((row) => ({ ...row, changed: 2 }));
  setInputs(page, JSON.stringify(left), JSON.stringify(right));
  await page.doCompare();
  await page.goToDiff(4999);
  for (const side of ['left', 'right']) {
    assert.equal(page.get('tree-' + side).querySelector('.entry.current').dataset.path, '/4999/changed');
    assert.ok(page.get('tree-' + side).querySelectorAll('.entry').length <= 45);
    assert.ok(page.treeViews[side].rowCount > 25000);
  }
});

test('nested container toggles follow keyed-array pairing on the opposite side', async () => {
  const page = loadCompare();
  page.get('array-mode').value = 'key';
  page.get('key-field').value = 'id';
  setInputs(page,
    '[{"id":1,"nested":{"value":1}},{"id":2,"nested":{"value":2}}]',
    '[{"id":2,"nested":{"value":3}},{"id":1,"nested":{"value":4}}]');
  await page.doCompare();
  const entry = page.get('tree-left').querySelectorAll('.entry').find((item) =>
    item.dataset.path === '/0/nested' && !item.classList.contains('virtual-close'));
  entry.querySelector('.toggle').click();
  await settle();
  assert.equal(page.state.collapsed.left.has('/0/nested'), true);
  assert.equal(page.state.collapsed.right.has('/1/nested'), true);
  assert.ok(!visiblePaths(page, 'right').includes('/1/nested/value'));
});

test('added and removed keyed records expand only on their own side', async () => {
  const page = loadCompare();
  page.get('array-mode').value = 'key';
  page.get('key-field').value = 'id';
  setInputs(page, '[{"id":1},{"id":2},{"id":4}]', '[{"id":3},{"id":1},{"id":2}]');
  await page.doCompare();
  for (const [side, other, index] of [['right', 'left', 0], ['left', 'right', 2]]) {
    const path = '/' + index;
    const entry = page.get('tree-' + side).querySelectorAll('.entry').find((item) => item.dataset.path === path);
    entry.querySelector('.toggle').click();
    await settle();
    assert.ok(visiblePaths(page, side).includes(path + '/id'));
    assert.ok(!visiblePaths(page, other).includes(path + '/id'));
  }
});

test('truncated keyed arrays isolate unknown records and still sync unrelated paths and newer gestures', async () => {
  const handler = createTaskHandler();
  const checks = [];
  let hold = false;
  let fail = false;
  const page = loadCompare(async (action, payload) => {
    if (action === 'comparisonPair' && fail) return { ok: false, code: 'WORKER_FAILED' };
    const response = handler({ action, ...payload });
    if (action === 'comparisonPair' && hold) await new Promise((resolve) => checks.push(resolve));
    return response;
  });
  page.get('array-mode').value = 'key';
  page.get('key-field').value = 'id';
  // The outer move is retained in the last slot, the nested moves are omitted.
  const full = Array.from({ length: 99999 }, (_, id) => ({ id }));
  const common = { '2026': { year: 1 }, '': { empty: 1 }, fallback: [{ id: 1 }, { id: 1 }] };
  const left = { ...common, full, rows: [{ id: 1, inner: [{ id: 1 }, { id: 2 }] }, { id: 2 }] };
  const right = { ...common, full: [...full.slice(1), full[0]], rows: [{ id: 2 }, { id: 1, inner: [{ id: 2 }, { id: 1 }] }] };
  setInputs(page, JSON.stringify(left), JSON.stringify(right));
  await page.doCompare();
  await settle();
  assert.equal(page.state.result.pairsTruncated, true);
  async function toggle(side, path) {
    const entry = page.get('tree-' + side).querySelectorAll('.entry').find((item) => item.dataset.path === path);
    entry.querySelector('.toggle').click();
    await settle();
  }
  for (const path of ['/2026', '/', '/fallback', '/fallback/0', '/rows', '/rows/0', '/rows/0/inner']) {
    await toggle('left', path);
  }
  const peerPaths = visiblePaths(page, 'right');
  for (const path of ['/2026/year', '//empty', '/fallback/0/id', '/rows/1/inner/0']) {
    assert.ok(peerPaths.includes(path), path);
  }
  await toggle('left', '/rows/0/inner/0');
  assert.ok(visiblePaths(page).includes('/rows/0/inner/0/id'));
  assert.ok(!visiblePaths(page, 'right').includes('/rows/1/inner/0/id'));

  hold = true;
  await toggle('left', '/2026');
  await toggle('right', '/2026');
  await toggle('right', '/2026');
  assert.equal(checks.length, 3);
  for (const resume of checks.reverse()) { resume(); await settle(); }
  for (const side of ['left', 'right']) assert.ok(visiblePaths(page, side).includes('/2026/year'));

  fail = true;
  await toggle('left', '/fallback/0');
  assert.equal(page.get('error').textContent, 'errWorkerFailed');
  assert.ok(visiblePaths(page, 'right').includes('/fallback/0/id'));
  fail = false;
  checks.length = 0;
  await toggle('left', '/2026');
  page.doClear();
  setInputs(page, '{"2026":{"year":1}}', '{"2026":{"year":1}}');
  await page.doCompare();
  await toggle('right', '/2026');
  checks[0]();
  await settle();
  for (const side of ['left', 'right']) assert.ok(visiblePaths(page, side).includes('/2026/year'));
  page.doClear();
});
