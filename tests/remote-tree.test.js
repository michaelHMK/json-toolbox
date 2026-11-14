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
      if (result.code === 'TREE_MODEL_UNAVAILABLE') return Promise.resolve(result);
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

function activate(container, path) {
  const entry = container.querySelectorAll('.entry').find((row) => row.dataset.path === path && !row.classList.contains('virtual-close'));
  assert.ok(entry, `Expected a mounted entry for ${path}`);
  entry.querySelector('.row').events.pointerdown();
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
  const restored = worker.requests.filter((request) => request.options).at(-1);
  assert.ok(restored.options.expanded.has('/branch/child'));
  assert.equal(worker.requests.filter((request) => request.options).length, 2, 'only initialization and recovery send full configuration');
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

test('routine windows, toggles and keyboard navigation do not resend the complete tree configuration', () => withDom(async () => {
  const worker = session(JSON.stringify({ branch: { n: 1 }, rows: Array(2000).fill(1) }));
  const requiredChildren = new Map(Array.from({ length: 5000 }, (_, index) => [`/unused/${index}`, new Set([`/unused/${index}/n`])]));
  const container = new Element();
  const tree = createRemoteTree(container, { request: worker.request, requiredChildren });
  await tree.ready;
  await tree.setOpen('/branch', true);
  await tree.reveal('/branch');
  await press(container, 'ArrowRight');
  await press(container, 'ArrowDown');
  await tree.setOpen('/rows', true);
  container.scrollTop = 30_000;
  tree.refresh();
  await settle();
  assert.equal(worker.requests[0].options.requiredChildren.size, 5000);
  assert.ok(worker.requests.some((request) => request.operation === 'rows'));
  assert.ok(worker.requests.some((request) => request.operation === 'move'));
  assert.ok(worker.requests.some((request) => request.operation === 'child'));
  for (const request of worker.requests.slice(1)) assert.equal(Object.hasOwn(request, 'options'), false, request.operation);
  await tree.update({ onlyRequired: false });
  await settle();
  const updates = worker.requests.filter((request) => request.options);
  assert.equal(updates.length, 2);
  assert.equal(updates[1].operation, 'update');
  assert.equal(updates[1].options.requiredChildren.size, 5000);
  tree.destroy();
}));

test('concurrent windows and a toggle share one configuration restore after Worker replacement', () => withDom(async () => {
  const worker = session(JSON.stringify({ branch: { n: 1 }, rows: Array(2000).fill(1), hidden: 2 }));
  const container = new Element();
  const tree = createRemoteTree(container, {
    request: worker.request, onlyRequired: true,
    requiredChildren: new Map([
      ['', new Set(['/branch', '/rows'])], ['/branch', new Set(['/branch/n'])],
      ['/rows', new Set(Array.from({ length: 2000 }, (_, index) => '/rows/' + index))],
    ]),
  });
  await tree.ready;
  await tree.setOpen('/rows', true);
  const before = tree.rowCount;
  const requestCount = worker.requests.length;
  worker.reset();
  const toggled = tree.setOpen('/branch', true);
  container.scrollTop = 30_000;
  tree.refresh();
  await toggled;
  await settle();
  const recovery = worker.requests.slice(requestCount).filter((request) => request.options);
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].operation, 'update');
  assert.equal(recovery[0].options.onlyRequired, true);
  assert.equal(recovery[0].options.expanded.has('/rows'), true);
  assert.equal(recovery[0].options.expanded.has('/branch'), true);
  assert.equal(tree.rowCount, before + 2);
  assert.equal(container.querySelectorAll('.entry').some((row) => row.dataset.path === '/hidden'), false);
  tree.destroy();
}));

test('a superseded recovery never replays an old toggle over the latest state', () => withDom(async () => {
  const worker = session('{"branch":{"n":1}}');
  let delay = false;
  let release;
  const container = new Element();
  const tree = createRemoteTree(container, { request: async (payload) => {
    const response = await worker.request(payload);
    if (delay && payload.operation === 'update') return new Promise((resolve) => { release = () => resolve(response); });
    return response;
  } });
  await tree.ready;
  worker.reset();
  delay = true;
  const old = tree.setOpen('/branch', true);
  await settle();
  await tree.setOpen('/branch', false);
  release();
  await old;
  assert.equal(tree.rowCount, 3);
  assert.deepEqual(worker.requests.filter((request) => request.operation === 'setOpen').map((request) => request.open), [true, false]);
  tree.destroy();
}));

test('destroy during model recovery prevents its queued operation from being replayed', () => withDom(async () => {
  const worker = session('{"branch":{"n":1}}');
  let delay = false;
  let release;
  const container = new Element();
  const tree = createRemoteTree(container, { request: async (payload) => {
    const response = await worker.request(payload);
    if (delay && payload.operation === 'update') return new Promise((resolve) => { release = () => resolve(response); });
    return response;
  } });
  await tree.ready;
  worker.reset();
  delay = true;
  const pending = tree.setOpen('/branch', true);
  await settle();
  const count = worker.requests.length;
  tree.destroy();
  release();
  await pending;
  assert.equal(worker.requests.length, count);
  assert.equal(container.children.length, 0);
  assert.equal(tree.rowCount, 0);
}));

test('a delayed expansion keeps a newer pointer selection and resolves its shifted row index', () => withDom(async () => {
  const worker = session('{"first":{"n":1},"second":2,"third":3}');
  let release;
  const container = new Element();
  const tree = createRemoteTree(container, { request: async (payload) => {
    const response = await worker.request(payload);
    if (payload.operation === 'setOpen') return new Promise((resolve) => { release = () => resolve(response); });
    return response;
  } });
  await tree.ready;
  activate(container, '/first');
  const pending = tree.setOpen('/first', true);
  await settle();
  activate(container, '/second');
  release();
  await pending;
  assert.equal(tree.rowCount, 7, 'the legal expansion result must still be installed');
  assert.equal(activeEntry(container).dataset.path, '/second');
  assert.match(activeEntry(container).id, /-item-4$/);
  assert.equal(await press(container, 'ArrowDown'), '/third');
  const resolved = worker.requests.find((request) => request.operation === 'resolve');
  assert.equal(resolved.activePath, '/second');
  assert.equal(Object.hasOwn(resolved, 'options'), false);
  tree.destroy();
}));

test('a pointer selection hidden by a pending collapse falls back to its visible ancestor', () => withDom(async () => {
  const worker = session('{"branch":{"leaf":1},"next":2}');
  let release;
  const container = new Element();
  const tree = createRemoteTree(container, { expandLevel: Infinity, request: async (payload) => {
    const response = await worker.request(payload);
    if (payload.operation === 'setOpen') return new Promise((resolve) => { release = () => resolve(response); });
    return response;
  } });
  await tree.ready;
  const pending = tree.setOpen('/branch', false);
  await settle();
  activate(container, '/branch/leaf');
  release();
  await pending;
  assert.equal(tree.rowCount, 4);
  assert.equal(activeEntry(container).dataset.path, '/branch');
  assert.equal(activeEntry(container).getAttribute('aria-expanded'), 'false');
  assert.equal(await press(container, 'ArrowDown'), '/next');
  tree.destroy();
}));

test('a second pointer choice during active-path resolution wins without losing the expansion', () => withDom(async () => {
  const worker = session('{"branch":{"n":1},"second":2,"third":3}');
  const releases = [];
  let heldResolve = false;
  const container = new Element();
  const tree = createRemoteTree(container, { request: async (payload) => {
    const response = await worker.request(payload);
    if (payload.operation === 'setOpen' || (payload.operation === 'resolve' && !heldResolve)) {
      if (payload.operation === 'resolve') heldResolve = true;
      return new Promise((resolve) => releases.push(() => resolve(response)));
    }
    return response;
  } });
  await tree.ready;
  const pending = tree.setOpen('/branch', true);
  await settle();
  activate(container, '/second');
  releases[0]();
  await settle();
  activate(container, '/third');
  releases[1]();
  await pending;
  assert.equal(tree.rowCount, 7);
  assert.equal(activeEntry(container).dataset.path, '/third');
  assert.match(activeEntry(container).id, /-item-5$/);
  assert.equal(worker.requests.filter((request) => request.operation === 'resolve').length, 2);
  tree.destroy();
}));

test('a delayed reveal cannot override a pointer selection made after navigation started', () => withDom(async () => {
  const worker = session('{"branch":{"leaf":1},"next":2}');
  let release;
  const container = new Element();
  const tree = createRemoteTree(container, { request: async (payload) => {
    const response = await worker.request(payload);
    if (payload.operation === 'reveal') return new Promise((resolve) => { release = () => resolve(response); });
    return response;
  } });
  await tree.ready;
  const pending = tree.reveal('/branch/leaf');
  await settle();
  activate(container, '/next');
  release();
  await pending;
  assert.equal(tree.rowCount, 6);
  assert.equal(activeEntry(container).dataset.path, '/next');
  tree.destroy();
}));

test('pointer activation supersedes older queued keyboard movements as well as their pending response', () => withDom(async () => {
  const worker = session('[0,1,2,3,4,5]');
  let release;
  const container = new Element();
  const tree = createRemoteTree(container, { request: async (payload) => {
    const response = await worker.request(payload);
    if (payload.operation === 'move') return new Promise((resolve) => { release = () => resolve(response); });
    return response;
  } });
  await tree.ready;
  container.events.keydown({ key: 'ArrowDown', preventDefault() {} });
  container.events.keydown({ key: 'ArrowDown', preventDefault() {} });
  await settle();
  activate(container, '/3');
  release();
  await settle();
  assert.equal(activeEntry(container).dataset.path, '/3');
  assert.equal(worker.requests.filter((request) => request.operation === 'move').length, 1);
  tree.destroy();
}));

test('keyboard movement waits for a pending pointer-path correction before reading row indexes', () => withDom(async () => {
  const worker = session('{"a":{"x":1,"y":2},"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8,"i":9}');
  let releaseCollapse;
  let releaseResolve;
  const container = new Element();
  const tree = createRemoteTree(container, { expandLevel: Infinity, request: async (payload) => {
    const response = await worker.request(payload);
    if (payload.operation === 'setOpen') return new Promise((resolve) => { releaseCollapse = () => resolve(response); });
    if (payload.operation === 'resolve') return new Promise((resolve) => { releaseResolve = () => resolve(response); });
    return response;
  } });
  await tree.ready;
  const pending = tree.setOpen('/a', false);
  await settle();
  activate(container, '/d');
  releaseCollapse();
  await settle();
  assert.equal(typeof releaseResolve, 'function');
  container.events.keydown({ key: 'ArrowDown', preventDefault() {} });
  await settle();
  assert.equal(worker.requests.some((request) => request.operation === 'move'), false, 'no navigation may use the pre-collapse index');
  releaseResolve();
  await pending;
  await settle();
  assert.equal(activeEntry(container).dataset.path, '/e');
  tree.destroy();
}));

test('ArrowRight waits for active-path correction before deciding which container to enter', () => withDom(async () => {
  const worker = session('{"a":{"x":1,"y":2},"b":{"child":3},"c":4,"d":5,"e":6}');
  let releaseCollapse;
  let releaseResolve;
  const container = new Element();
  const tree = createRemoteTree(container, { expandLevel: Infinity, request: async (payload) => {
    const response = await worker.request(payload);
    if (payload.operation === 'setOpen') return new Promise((resolve) => { releaseCollapse = () => resolve(response); });
    if (payload.operation === 'resolve') return new Promise((resolve) => { releaseResolve = () => resolve(response); });
    return response;
  } });
  await tree.ready;
  const pending = tree.setOpen('/a', false);
  await settle();
  activate(container, '/b');
  releaseCollapse();
  await settle();
  container.events.keydown({ key: 'ArrowRight', preventDefault() {} });
  await settle();
  assert.equal(worker.requests.some((request) => request.operation === 'child'), false);
  releaseResolve();
  await pending;
  await settle();
  assert.equal(activeEntry(container).dataset.path, '/b/child');
  tree.destroy();
}));

test('window-driven recovery refreshes the active index after a cancelled expansion intention', () => withDom(async () => {
  const worker = session(JSON.stringify({ first: { n: 1 }, rows: Array(2000).fill(1) }));
  let cancelToggle = false;
  const container = new Element();
  const tree = createRemoteTree(container, { request: (payload) => {
    if (cancelToggle && payload.operation === 'setOpen') return Promise.resolve({ ok: false, cancelled: true });
    return worker.request(payload);
  } });
  await tree.ready;
  await tree.reveal('/rows/500');
  const previousCount = tree.rowCount;
  cancelToggle = true;
  await tree.setOpen('/first', true);
  worker.reset();
  cancelToggle = false;
  container.scrollTop = 38_000;
  tree.refresh();
  await settle();
  assert.equal(tree.rowCount, previousCount + 2, 'recovery includes the remembered open intention');
  assert.equal(activeEntry(container).dataset.path, '/rows/500');
  assert.match(activeEntry(container).id, /-item-505$/);
  assert.equal(await press(container, 'ArrowDown'), '/rows/501');
  tree.destroy();
}));

test('ArrowRight stays on a filtered container with no visible children, while ArrowDown reaches its sibling', () => withDom(async () => {
  const worker = session('{"branch":{"hidden":1},"next":2}');
  const container = new Element();
  const tree = createRemoteTree(container, {
    request: worker.request, expandLevel: Infinity, onlyRequired: true,
    requiredChildren: new Map([['', new Set(['/branch', '/next'])]]),
  });
  await tree.ready;
  await tree.reveal('/branch');
  assert.equal(await press(container, 'ArrowRight'), '/branch');
  assert.equal(await press(container, 'ArrowDown'), '/next');
  tree.destroy();
}));
