import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage } from './helpers/page-dom.js';

// Exercise page behavior through the virtual viewport and navigation actions.
function loadFormatter(runTask) {
  return loadPage('formatter', {
    runTask,
    expose: '{ state, renderTree, applyLevel, doClear, doFormat, ensureTreeData, runSearch, getTree: () => treeView }',
  });
}

function findEntry(page, path) {
  return page.get('tree').querySelectorAll('.entry').find((entry) =>
    entry.dataset.path === path && !entry.classList.contains('virtual-close'));
}

test('expand all indexes all levels while keeping only viewport rows in the DOM', () => {
  const page = loadFormatter();
  page.state.data = Array.from({ length: 201 }, (_, id) => ({ id, profile: { name: 'user' } }));
  page.applyLevel('all');
  assert.equal(page.state.expanded.size, 0);
  assert.ok(page.getTree().rowCount > 1000);
  assert.ok(page.get('tree').querySelectorAll('.entry').length <= 45);
  assert.equal(findEntry(page, '/0/profile').querySelector('.toggle').textContent, '▾');
  assert.equal(page.getTree().reveal('/200/profile/name'), true);
  assert.equal(findEntry(page, '/200/profile/name').querySelector('.v').textContent, '"user"');
  assert.ok(page.get('tree').querySelectorAll('.entry').length <= 45);
});

test('default view does not visit hidden array values', () => {
  const page = loadFormatter();
  const data = Array(1_000_000).fill(1);
  let allowLast = false;
  Object.defineProperty(data, 999999, { get() { assert.ok(allowLast); return 7; } });
  page.state.data = data;
  page.renderTree();
  assert.equal(page.getTree().rowCount, 1_000_002);
  allowLast = true;
  page.getTree().reveal('/999999');
  assert.equal(findEntry(page, '/999999').querySelector('.v').textContent, '7');
});

test('manual collapse overrides expand all across rerenders and a new level resets it', () => {
  const page = loadFormatter();
  page.state.data = { first: { nested: { value: 1 } } };
  page.applyLevel('all');
  findEntry(page, '/first').querySelector('.toggle').click();
  assert.equal(findEntry(page, '/first/nested'), undefined);
  page.renderTree();
  assert.equal(findEntry(page, '/first/nested'), undefined);
  assert.equal(findEntry(page, '/first').querySelector('.toggle').textContent, '▸');
  page.applyLevel('2');
  assert.equal(findEntry(page, '/first').querySelector('.toggle').textContent, '▾');
  assert.equal(findEntry(page, '/first/nested').querySelector('.toggle').textContent, '▸');
  page.doClear();
  assert.equal(page.state.expandLevel, 1);
  assert.equal(page.state.collapsed.size, 0);
  assert.equal(page.getTree(), null);
});

test('search exposes a distant match without rendering every earlier sibling', () => {
  const page = loadFormatter();
  page.state.data = Array.from({ length: 25001 }, (_, id) => id);
  page.state.highlights = new Set(['/25000']);
  page.state.searchForce = new Set(['']);
  page.state.searchQuery = '25000';
  page.state.matchCount = 1;
  page.renderTree();
  assert.ok(page.get('tree').querySelectorAll('.entry').length <= 45);
  assert.equal(page.get('tree').querySelector('.entry.current').dataset.path, '/25000');
  assert.equal(page.state.matchIndex, 0);
});

test('search navigation reaches offscreen matches and retains source order around them', () => {
  const page = loadFormatter();
  page.state.data = Array.from({ length: 601 }, (_, id) => id);
  page.state.highlights = new Set(['/400', '/500']);
  page.state.searchForce = new Set(['']);
  page.state.searchQuery = 'match';
  page.state.matchCount = 2;
  page.renderTree();
  assert.equal(page.get('tree').querySelector('.entry.current').dataset.path, '/400');
  page.get('match-next').click();
  assert.equal(page.get('tree').querySelector('.entry.current').dataset.path, '/500');
  const keys = page.get('tree').querySelectorAll('.key').map((entry) => Number(entry.textContent));
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(keys, [...keys].sort((a, b) => a - b));
  page.get('match-prev').click();
  assert.equal(page.get('tree').querySelector('.entry.current').dataset.path, '/400');
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
  finishFormat({ ok: true, result: { text: '{"old":1}', data: { old: 1 } }, duration: 1 });
  await pending;
  assert.deepEqual(actions, ['format', 'clear']);
  assert.equal(page.state.data, undefined);
  assert.equal(page.state.outputText, '');
  assert.equal(page.get('tree').children.length, 0);
});

test('clear invalidates pending parsing and search results', async () => {
  for (const action of ['parse', 'search']) {
    let finishTask;
    const page = loadFormatter((requested) => requested === action
      ? new Promise((resolve) => { finishTask = resolve; })
      : Promise.resolve({ ok: true, result: {} }));
    page.get('input').value = '{"old":1}';
    page.get('search').value = 'old';
    if (action === 'search') page.state.data = { old: 1 };
    const pending = action === 'parse' ? page.ensureTreeData() : page.runSearch();
    // A restarted Worker first restores the document before searching it.
    await new Promise(setImmediate);
    page.doClear();
    finishTask({ ok: true, result: action === 'parse'
      ? { data: { old: 1 }, numberLiterals: {} }
      : { highlights: ['/old'], forceExpand: [''], matchCount: 1, truncated: false } });
    await pending;
    assert.equal(page.state.data, undefined);
    assert.equal(page.state.highlights.size, 0);
    assert.equal(page.get('tree').children.length, 0);
  }
});
