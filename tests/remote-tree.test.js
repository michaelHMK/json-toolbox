import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteTree } from '../src/shared/remote-tree.js';
import { createTaskHandler } from '../src/worker/tasks.js';
import { Element } from './helpers/page-dom.js';

async function withDom(run) {
  const previous = globalThis.document;
  globalThis.document = {
    createElement: (tag) => new Element(tag),
    createDocumentFragment: () => new Element('#fragment'),
  };
  try { await run(); }
  finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function session(text) {
  let handler = createTaskHandler();
  let snapshotId;
  const requests = [];
  const reset = () => {
    handler = createTaskHandler();
    const response = handler({ action: 'parse', text, includeData: false, retainSnapshot: true });
    assert.equal(response.ok, true);
    assert.equal(Object.hasOwn(response.result, 'data'), false);
    snapshotId = response.result.snapshotId;
  };
  reset();
  return {
    requests, reset,
    request(payload) {
      requests.push(payload);
      const result = structuredClone(handler({ action: 'tree', kind: 'document', snapshotId, ...structuredClone(payload) }));
      assert.equal(result.ok, true, result.error);
      assert.ok(result.result.rows.length <= 256);
      for (const row of [...result.result.rows, result.result.activeRow].filter(Boolean)) {
        if (row.value && typeof row.value === 'object') assert.deepEqual(Object.keys(row.value), []);
        if (typeof row.value === 'string') assert.ok(row.value.length <= 2000);
      }
      return Promise.resolve(result);
    },
  };
}

function activeEntry(container) {
  const id = container.getAttribute('aria-activedescendant');
  return container.querySelectorAll('.entry').find((entry) => entry.id === id);
}

async function press(container, key) {
  let prevented = false;
  container.events.keydown({ key, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  await settle();
  return activeEntry(container)?.dataset.path;
}

test('remote tree renders bounded windows and keeps the active ARIA row mounted', () => withDom(async () => {
  const worker = session(JSON.stringify(Array.from({ length: 20_000 }, (_, i) => ({ id: i }))));
  const container = new Element();
  const tree = createRemoteTree(container, { request: worker.request });
  await tree.ready;
  assert.equal(tree.rowCount, 20_002);
  assert.equal(activeEntry(container).dataset.path, '');
  assert.ok(container.querySelectorAll('.entry').length < 60);
  container.scrollTop = 100_000;
  tree.refresh();
  await settle();
  assert.equal(activeEntry(container).dataset.path, '');
  assert.equal(activeEntry(container).classList.contains('virtual-active-outside'), true);
  assert.equal(await press(container, 'End'), '/19999');
  assert.equal(await press(container, 'ArrowRight'), '/19999');
  assert.equal(await press(container, 'ArrowRight'), '/19999/id');
  assert.equal(await press(container, 'ArrowLeft'), '/19999');
  assert.equal(await press(container, 'ArrowLeft'), '/19999');
  assert.equal(tree.rowCount, 20_002);
  assert.ok(container.querySelectorAll('.entry').length < 60);
  tree.destroy();
  assert.equal(tree.rowCount, 0);
  assert.equal(container.children.length, 0);
}));

test('remote previews preserve sizes, literal spellings and truncation metadata', () => withDom(async () => {
  const worker = session('{"wide":[' + Array(100).fill('1').join(',') + '],"long":'
    + JSON.stringify('😀'.repeat(3000)) + ',"precise":9007199254740993}');
  const container = new Element();
  const tree = createRemoteTree(container, { request: worker.request });
  await tree.ready;
  const wide = container.querySelectorAll('.entry').find((row) => row.dataset.path === '/wide');
  assert.equal(wide.getAttribute('aria-expanded'), 'false');
  const values = container.querySelectorAll('.v').map((row) => row.textContent);
  assert.ok(values[0].endsWith('strTruncated'));
  assert.ok(values[0].length < 2100);
  assert.equal(values[1], '9007199254740993');
  await tree.setOpen('/wide', true);
  assert.equal(tree.rowCount, 106);
  tree.destroy();
}));

test('stale remote mutations and responses after destroy never replace current rows', () => withDom(async () => {
  const worker = session('{"nested":{"deep":{"value":1}}}');
  const pending = [];
  let delayed = false;
  const container = new Element();
  const tree = createRemoteTree(container, { request: async (payload) => {
    const response = await worker.request(payload);
    if (!delayed) return response;
    return new Promise((resolve) => pending.push(() => resolve(response)));
  } });
  await tree.ready;
  delayed = true;
  const old = tree.update({ expandLevel: Infinity });
  const latest = tree.update({ expandLevel: 1 });
  await settle();
  pending[1]();
  await latest;
  assert.equal(tree.rowCount, 3);
  pending[0]();
  await old;
  assert.equal(tree.rowCount, 3);
  const outstanding = tree.reveal('/nested/deep/value');
  await settle();
  tree.destroy();
  pending[2]();
  await outstanding;
  assert.equal(container.children.length, 0);
}));

test('remote cache is bounded and carries expansion state into a replacement Worker', () => withDom(async () => {
  const worker = session(JSON.stringify({ branch: { child: { n: 1 } }, rows: Array(20_000).fill(1) }));
  const container = new Element();
  const tree = createRemoteTree(container, { request: worker.request });
  await tree.ready;
  await tree.reveal('/branch/child/n');
  await tree.setOpen('/rows', true);
  const expected = tree.rowCount;
  worker.reset();
  for (let n = 1; n <= 8; n++) {
    container.scrollTop = n * 40_000;
    tree.refresh();
    await settle();
    assert.equal(tree.rowCount, expected);
  }
  const before = worker.requests.length;
  container.scrollTop = 0;
  tree.refresh();
  await settle();
  assert.ok(worker.requests.length > before, 'old windows are evicted instead of retaining all visited rows');
  assert.ok(container.querySelectorAll('.entry').some((row) => row.dataset.path === '/branch/child/n'));
  assert.ok(worker.requests.at(-1).options.expanded.has('/branch/child'));
  tree.destroy();
}));

test('rapid remote toggles notify every intent and preserve native text nodes on pointer activation', () => withDom(async () => {
  const worker = session('{"first":{"n":1},"second":{"n":2}}');
  const container = new Element();
  const changes = [];
  const tree = createRemoteTree(container, { request: worker.request, onToggle: (...args) => changes.push(args) });
  await tree.ready;
  const first = container.querySelectorAll('.entry').find((row) => row.dataset.path === '/first');
  const second = container.querySelectorAll('.entry').find((row) => row.dataset.path === '/second');
  first.querySelector('.toggle').click();
  second.querySelector('.toggle').click();
  await settle();
  assert.deepEqual(changes, [['/first', true], ['/second', true]]);
  const value = container.querySelector('.v');
  value.parentElement.events.pointerdown();
  assert.equal(container.querySelector('.v'), value);
  tree.destroy();
}));

test('queued remote keyboard events each advance from the preceding response', () => withDom(async () => {
  const worker = session('[1,2,3,4,5]');
  const container = new Element();
  const tree = createRemoteTree(container, { request: worker.request });
  await tree.ready;
  for (let i = 0; i < 4; i++) container.events.keydown({ key: 'ArrowDown', preventDefault() {} });
  await settle();
  assert.equal(activeEntry(container).dataset.path, '/3');
  tree.destroy();
}));

test('two clicks before a Worker response restore the original open state', () => withDom(async () => {
  const worker = session('{"branch":{"n":1}}');
  const container = new Element();
  const changes = [];
  const tree = createRemoteTree(container, { request: worker.request, onToggle: (...args) => changes.push(args) });
  await tree.ready;
  const branch = container.querySelectorAll('.entry').find((row) => row.dataset.path === '/branch');
  branch.querySelector('.toggle').click();
  branch.querySelector('.toggle').click();
  await settle();
  assert.deepEqual(changes, [['/branch', true], ['/branch', false]]);
  assert.equal(tree.rowCount, 3);
  tree.destroy();
}));

test('manual remote expansion survives page options refresh and a stale window cannot block new rows', () => withDom(async () => {
  const worker = session(JSON.stringify(Array.from({ length: 20_000 }, () => ({ n: 1 }))));
  const expanded = new Set();
  const collapsed = new Set();
  let release;
  let hold = false;
  const container = new Element();
  const tree = createRemoteTree(container, { expanded, collapsed, request: async (payload) => {
    const result = await worker.request(payload);
    if (hold && payload.operation === 'rows') {
      hold = false;
      return new Promise((resolve) => { release = () => resolve(result); });
    }
    return result;
  } });
  await tree.ready;
  await tree.setOpen('/0', true);
  assert.equal(expanded.has('/0'), true);
  await tree.update({ expanded, collapsed });
  assert.equal(tree.rowCount, 20_004);
  hold = true;
  container.scrollTop = 100_000;
  tree.refresh();
  await settle();
  await tree.update({ expanded, collapsed });
  await settle();
  assert.equal(container.querySelectorAll('.virtual-placeholder').length, 0);
  release();
  await settle();
  assert.equal(container.querySelectorAll('.virtual-placeholder').length, 0);
  tree.destroy();
}));

test('an initial reveal grows the scroller before browsers clamp its scroll position', () => withDom(async () => {
  const worker = session(JSON.stringify(Array(20_000).fill(1)));
  const container = new Element();
  let top = 0;
  Object.defineProperty(container, 'scrollTop', {
    get: () => top,
    set(value) {
      const height = Number.parseFloat(container.children[0]?.style.height) || 0;
      top = Math.max(0, Math.min(Math.max(0, height - container.clientHeight), value));
    },
  });
  const tree = createRemoteTree(container, { request: worker.request });
  await tree.reveal('/19999');
  await tree.ready;
  assert.ok(container.scrollTop > 400_000);
  assert.equal(activeEntry(container).dataset.path, '/19999');
  assert.equal(activeEntry(container).classList.contains('virtual-active-outside'), false);
  tree.destroy();
}));
