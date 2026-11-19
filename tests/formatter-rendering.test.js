import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage } from './helpers/page-dom.js';
import { createSessionWorker } from './helpers/session-worker.js';

const settle = () => new Promise(setImmediate);

// Exercise page behavior through the virtual viewport and navigation actions.
function loadFormatter(runTask) {
  if (runTask) {
    return loadPage('formatter', {
      runTask,
      expose: '{ state, renderTree, applyLevel, doClear, doFormat, setView, ensureTreeData, runSearch, getTree: () => treeView }',
    });
  }
  const worker = createSessionWorker();
  return loadPage('formatter', {
    createTaskRunner: worker.createRunner,
    expose: '{ state, renderTree, applyLevel, doClear, doFormat, setView, ensureTreeData, runSearch, getTree: () => treeView }',
  });
}

function findEntry(page, path) {
  return page.get('tree').querySelectorAll('.entry').find((entry) =>
    entry.dataset.path === path && !entry.classList.contains('virtual-close'));
}

async function openTree(page, value) {
  page.get('input').value = JSON.stringify(value);
  await page.setView('tree');
}

test('expand all indexes all levels while keeping only viewport rows in the DOM', async () => {
  const page = loadFormatter();
  await openTree(page, Array.from({ length: 201 }, (_, id) => ({ id, profile: { name: 'user' } })));
  await page.applyLevel('all');
  assert.equal(page.state.expanded.size, 0);
  assert.ok(page.getTree().rowCount > 1000);
  assert.ok(page.get('tree').querySelectorAll('.entry').length <= 45);
  assert.equal(findEntry(page, '/0/profile').querySelector('.toggle').textContent, '▾');
  assert.equal(await page.getTree().reveal('/200/profile/name'), true);
  assert.equal(findEntry(page, '/200/profile/name').querySelector('.v').textContent, '"user"');
  assert.ok(page.get('tree').querySelectorAll('.entry').length <= 45);
  page.doClear();
});

test('default view bounds DOM on a large array and reaches its final value on demand', async () => {
  const page = loadFormatter();
  const data = Array(50_000).fill(1);
  data[49_999] = 7;
  await openTree(page, data);
  assert.equal(page.getTree().rowCount, 50_002);
  assert.ok(page.get('tree').querySelectorAll('.entry').length <= 45);
  assert.equal(await page.getTree().reveal('/49999'), true);
  assert.equal(findEntry(page, '/49999').querySelector('.v').textContent, '7');
  page.doClear();
});

test('manual collapse overrides expand all across rerenders and a new level resets it', async () => {
  const page = loadFormatter();
  await openTree(page, { first: { nested: { value: 1 } } });
  await page.applyLevel('all');
  findEntry(page, '/first').querySelector('.toggle').click();
  await settle();
  assert.equal(findEntry(page, '/first/nested'), undefined);
  await page.renderTree();
  assert.equal(findEntry(page, '/first/nested'), undefined);
  assert.equal(findEntry(page, '/first').querySelector('.toggle').textContent, '▸');
  await page.applyLevel('2');
  assert.equal(findEntry(page, '/first').querySelector('.toggle').textContent, '▾');
  assert.equal(findEntry(page, '/first/nested').querySelector('.toggle').textContent, '▸');
  page.doClear();
  assert.equal(page.state.expandLevel, 1);
  assert.equal(page.state.collapsed.size, 0);
  assert.equal(page.getTree(), null);
});

test('search exposes a distant match without rendering every earlier sibling', async () => {
  const page = loadFormatter();
  await openTree(page, Array.from({ length: 25001 }, (_, id) => id));
  page.get('search').value = '25000';
  await page.runSearch();
  assert.ok(page.get('tree').querySelectorAll('.entry').length <= 45);
  assert.equal(page.get('tree').querySelector('.entry.current').dataset.path, '/25000');
  assert.equal(page.state.matchIndex, 0);
  page.doClear();
});

test('search navigation reaches offscreen matches and retains source order around them', async () => {
  const page = loadFormatter();
  const data = Array.from({ length: 601 }, (_, id) => (id === 400 || id === 500 ? 'needle' : id));
  await openTree(page, data);
  page.get('search').value = 'needle';
  await page.runSearch();
  assert.equal(page.get('tree').querySelector('.entry.current').dataset.path, '/400');
  await page.get('match-next').click();
  assert.equal(page.get('tree').querySelector('.entry.current').dataset.path, '/500');
  const keys = page.get('tree').querySelectorAll('.key').map((entry) => Number(entry.textContent));
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(keys, [...keys].sort((a, b) => a - b));
  await page.get('match-prev').click();
  assert.equal(page.get('tree').querySelector('.entry.current').dataset.path, '/400');
  page.doClear();
});

test('clear releases the Worker cache and ignores an outstanding format response', async () => {
  let finishFormat;
  const actions = [];
  const page = loadFormatter((action) => {
    actions.push(action);
    if (action === 'format') return new Promise((resolve) => { finishFormat = resolve; });
    return Promise.resolve({ ok: true, result: {} });
  });
  page.get('input').value = '{"old":1}';
  const pending = page.doFormat();
  page.doClear();
  finishFormat({ ok: true, result: { text: '{"old":1}', snapshotId: 1 }, duration: 1 });
  await pending;
  assert.deepEqual(actions, ['format', 'clear']);
  assert.equal(page.getTree(), null);
  assert.equal(page.state.outputText, '');
  assert.equal(page.get('tree').children.length, 0);
});

test('clear invalidates pending parsing and search results', async () => {
  for (const action of ['parse', 'search']) {
    let finishTask;
    const page = loadFormatter((requested) => requested === action
      ? new Promise((resolve) => { finishTask = resolve; })
      : Promise.resolve({ ok: true, result: requested === 'parse'
        ? { snapshotId: 1 } : {} }));
    page.get('input').value = '{"old":1}';
    page.get('search').value = 'old';
    if (action === 'search') await page.ensureTreeData();
    const pending = action === 'parse' ? page.ensureTreeData() : page.runSearch();
    // A restarted Worker first restores the document before searching it.
    await new Promise(setImmediate);
    page.doClear();
    finishTask({ ok: true, result: action === 'parse'
      ? { snapshotId: 1 }
      : { highlights: ['/old'], forceExpand: [''], matchCount: 1, truncated: false } });
    await pending;
    assert.equal(page.getTree(), null);
    assert.equal(page.state.highlights.size, 0);
    assert.equal(page.get('tree').children.length, 0);
  }
});
