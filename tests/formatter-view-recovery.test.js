import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionWorker } from './helpers/session-worker.js';
import { loadPage } from './helpers/page-dom.js';
import { LARGE_INPUT_THRESHOLD } from '../src/shared/text-input.js';

function setup() {
  const worker = createSessionWorker();
  const page = loadPage('formatter', {
    expose: '{ state, doFormat, doClear, getTree: () => treeView }',
    createTaskRunner: worker.createRunner,
  });
  return { page, ...worker };
}

function assertView(page, expected) {
  assert.equal(page.state.view, expected);
  assert.equal(page.get('view-' + expected).classList.contains('active'), true);
  assert.equal(page.get('view-' + expected).getAttribute('aria-pressed'), 'true');
  assert.equal(page.get('view-' + (expected === 'text' ? 'tree' : 'text')).getAttribute('aria-pressed'), 'false');
  assert.equal(page.get('tree').hidden, expected !== 'tree');
  if (expected === 'tree') {
    assert.ok(page.getTree(), 'the active tree must have been built');
    assert.ok(page.get('tree').querySelectorAll('.entry').length > 0);
  }
}

async function showTree(page) {
  await page.get('view-tree').click();
  assertView(page, 'tree');
}

for (const failure of ['cancel', 'parse error', 'worker error']) {
  test(`tree requested during format remains retryable after ${failure}`, async () => {
    const { page, workers, held } = setup();
    held.add('format');
    page.get('input').value = failure === 'parse error' ? '{' : '{"value":1}';
    const pending = page.doFormat();
    await page.get('view-tree').click();
    assert.equal(page.state.view, 'text', 'pending tree intent must not replace the rendered view');
    if (failure === 'cancel') page.get('btn-cancel').click();
    else if (failure === 'worker error') workers[0].crash();
    else workers[0].complete(workers[0].requests[0]);
    await pending;
    held.clear();
    if (failure === 'parse error') {
      page.get('input').value = '{"value":1}';
      page.get('input').events.input();
    }
    await showTree(page);
    assert.equal(page.state.data.value, 1);
    page.doClear();
  });
}

test('successful format fulfills the last pending view choice after building the tree', async () => {
  const { page, workers, held } = setup();
  held.add('format');
  page.get('input').value = '{"value":1.20}';
  const pending = page.doFormat();
  await page.get('view-tree').click();
  await page.get('view-text').click();
  await page.get('view-tree').click();
  assert.equal(page.state.view, 'text');
  held.clear();
  workers[0].complete(workers[0].requests[0]);
  await pending;
  assertView(page, 'tree');
  assert.equal(page.state.numberLiterals['/value'], '1.20');
  assert.deepEqual(workers[0].requests.map((request) => request.action), ['format', 'parseSnapshot']);
  page.doClear();
});

test('choosing text again during format withdraws the pending tree request', async () => {
  const { page, workers, held } = setup();
  held.add('format');
  page.get('input').value = '{"value":1}';
  const pending = page.doFormat();
  await page.get('view-tree').click();
  await page.get('view-text').click();
  held.clear();
  workers[0].complete(workers[0].requests[0]);
  await pending;
  assertView(page, 'text');
  assert.equal(page.getTree(), null);
  assert.deepEqual(workers[0].requests.map((request) => request.action), ['format']);
  page.doClear();
});

for (const action of ['edit', 'clear']) {
  test(`${action} cancels pending tree intent without affecting the next format`, async () => {
    const { page, workers, held } = setup();
    held.add('format');
    page.get('input').value = '{"old":1}';
    const pending = page.doFormat();
    await page.get('view-tree').click();
    if (action === 'clear') page.doClear();
    else page.get('input').events.input();
    await pending;
    assert.equal(workers[0].terminated, true);
    page.get('input').value = '{"fresh":2}';
    held.clear();
    await page.doFormat();
    assertView(page, 'text');
    assert.equal(page.getTree(), null);
    await showTree(page);
    assert.equal(page.state.data.fresh, 2);
    assert.equal(page.state.data.old, undefined);
    page.doClear();
  });
}

for (const failure of ['cancel', 'worker error']) {
  test(`completed text remains usable when the follow-up tree transfer ends with ${failure}`, async () => {
    const { page, workers, held } = setup();
    held.add('format');
    held.add('parseSnapshot');
    page.get('input').value = '{"fresh":2}';
    const pending = page.doFormat();
    await page.get('view-tree').click();
    held.delete('format');
    workers[0].complete(workers[0].requests[0]);
    await new Promise(setImmediate);
    assertView(page, 'text');
    assert.match(page.get('output-text').textContent, /fresh/);
    if (failure === 'cancel') page.get('btn-cancel').click();
    else workers[0].crash();
    await pending;
    held.clear();
    await showTree(page);
    assert.equal(page.state.data.fresh, 2);
    assert.deepEqual(workers[1].requests.map((request) => request.action), ['parse']);
    page.doClear();
  });
}

test('a late tree parse cannot override a newer request to keep text visible', async () => {
  const { page, workers, held } = setup();
  page.get('input').value = '{"value":1}';
  await page.doFormat();
  held.add('parseSnapshot');
  const pending = page.get('view-tree').click();
  await page.get('view-text').click();
  held.clear();
  workers[0].complete(workers[0].requests.at(-1));
  await pending;
  assertView(page, 'text');
  await showTree(page);
  assert.equal(page.state.data.value, 1);
  page.doClear();
});

for (const outcome of ['worker error', 'cancel', 'return to text', 'crash after returning to text']) {
  test(`first remote window keeps formatted text visible during ${outcome} and permits retry`, async () => {
    const { page, workers, held } = setup();
    page.get('input').value = JSON.stringify({ data: 'x'.repeat(LARGE_INPUT_THRESHOLD) });
    await page.doFormat();
    held.add('tree');
    const pending = page.get('view-tree').click();
    await new Promise(setImmediate);
    const firstWindow = workers[0].requests.at(-1);
    assert.equal(firstWindow.action, 'tree');
    assertView(page, 'text');
    assert.equal(page.get('output-text').hidden, false);
    assert.match(page.get('output-text').textContent, /"data"/);
    if (outcome === 'worker error') workers[0].crash();
    else if (outcome === 'cancel') await page.get('btn-cancel').click();
    else {
      await page.get('view-text').click();
      if (outcome === 'return to text') workers[0].complete(firstWindow);
      else workers[0].crash();
    }
    await pending;
    assertView(page, 'text');
    assert.equal(page.getTree(), null);
    if (outcome === 'worker error') assert.equal(page.get('error').textContent, 'errWorkerFailed');
    else assert.equal(page.get('error').hidden, true);
    held.clear();
    await showTree(page);
    assert.ok(page.get('tree').querySelectorAll('.key').some((entry) => entry.textContent.includes('data')));
    page.doClear();
  });
}

test('cancelling a search after switching views leaves a built and usable tree', async () => {
  const { page, held } = setup();
  page.get('input').value = '{"value":1}';
  await page.doFormat();
  page.get('search').value = '1';
  held.add('search');
  await showTree(page);
  page.get('btn-cancel').click();
  await new Promise(setImmediate);
  assertView(page, 'tree');
  await showTree(page);
  assert.equal(page.state.data.value, 1);
  page.doClear();
});

test('cancelling a new format preserves the old output and lets its tree be opened', async () => {
  const { page, held } = setup();
  page.get('input').value = '{"old":1}';
  await page.doFormat();
  const previousOutput = page.state.outputText;
  held.add('format');
  page.get('input').value = '{"fresh":2}';
  const pending = page.doFormat();
  await page.get('view-tree').click();
  page.get('btn-cancel').click();
  await pending;
  assertView(page, 'text');
  assert.equal(page.state.outputText, previousOutput);
  held.clear();
  await showTree(page);
  assert.equal(page.state.data.old, 1);
  assert.equal(page.state.data.fresh, undefined);
  page.doClear();
});

test('cancelling pending text intent preserves an already rendered old tree', async () => {
  const { page, held } = setup();
  page.get('input').value = '{"old":1}';
  await page.doFormat();
  await showTree(page);
  const previousTree = page.getTree();
  held.add('format');
  page.get('input').value = '{"fresh":2}';
  const pending = page.doFormat();
  await page.get('view-text').click();
  assertView(page, 'tree');
  page.get('btn-cancel').click();
  await pending;
  assertView(page, 'tree');
  assert.strictEqual(page.getTree(), previousTree);
  await page.get('view-text').click();
  assertView(page, 'text');
  page.doClear();
});

test('formatting an active tree does not build an unused text view', async () => {
  const { page } = setup();
  page.get('input').value = '{"old":1}';
  await page.doFormat();
  await showTree(page);
  page.get('input').value = '{"fresh":2}';
  await page.doFormat();
  assertView(page, 'tree');
  assert.equal(page.state.data.fresh, 2);
  assert.equal(page.get('output-text').children.length, 0);
  assert.equal(page.get('output-text').textContent, '');
  page.doClear();
});
