import test from 'node:test';
import assert from 'node:assert/strict';
import { createTreeModel } from '../src/core/tree-model.js';
import { createTreeTasks } from '../src/worker/tree-tasks.js';
import { createVirtualTree } from '../src/shared/virtual-tree.js';
import { createChildPathIndex } from '../src/core/json-path.js';
import { Element, withDom } from './helpers/page-dom.js';

const rows = (model) => Array.from({ length: model.rowCount }, (_, index) => model.rowAt(index));
const entryPaths = (model) => rows(model).filter((row) => row.kind === 'entry').map((row) => row.path);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeRequest(data, numberLiterals = null) {
  const treeTask = createTreeTasks();
  const snapshot = {};
  const document = { data, numberLiterals };
  return (payload) => Promise.resolve({ ok: true, result: treeTask(snapshot, document, payload) });
}

test('a million-element array is one lazy range with direct access to its final value', () => {
  let reads = 0;
  const data = new Proxy(Array(1_000_000).fill(7), {
    get(target, key) { if (/^\d+$/.test(String(key))) reads++; return target[key]; },
  });
  const model = createTreeModel({ data });
  assert.equal(model.rowCount, 1_000_002);
  assert.equal(reads, 0, 'initial indexing must not read a million children');
  assert.equal(model.indexOf('/999999'), 1_000_000);
  assert.equal(model.rowAt(1_000_000).value, 7);
  assert.equal(reads, 1);
  assert.equal(model.indexOf('/1000000'), -1);
});

test('level expansion and manual overrides preserve DFS rows and closing brackets', () => {
  const model = createTreeModel({ data: { first: { nested: { n: 1 } }, second: [2, 3] }, expandLevel: Infinity });
  assert.deepEqual(entryPaths(model), ['', '/first', '/first/nested', '/first/nested/n', '/second', '/second/0', '/second/1']);
  assert.deepEqual(rows(model).filter((row) => row.kind === 'close').map((row) => row.path), ['/first/nested', '/first', '/second', '']);
  model.setOpen('/first', false);
  assert.deepEqual(entryPaths(model), ['', '/first', '/second', '/second/0', '/second/1']);
  model.update({ expandLevel: 2, expanded: new Set(), collapsed: new Set() });
  assert.deepEqual(entryPaths(model), ['', '/first', '/first/nested', '/second', '/second/0', '/second/1']);
  assert.equal(model.indexOf('/first/nested/n'), -1);
  const index = model.reveal('/first/nested/n');
  assert.equal(model.rowAt(index).value, 1);
  assert.equal(model.reveal('/first/missing'), -1);
});

test('container reveal opens collapsed targets and locates sibling, trailing and filtered anchors', () => {
  const data = {
    empty: {},
    settings: { theme: 'dark' },
    wide: { a: 1, b: 2, c: 3, d: 4 },
    nestedTail: { branch: { leaf: 9 } },
  };
  const model = createTreeModel({ data, expandLevel: 1 });
  assert.equal(model.rowAt(model.reveal('/empty', { open: true })).path, '/empty');
  assert.equal(model.rowAt(model.reveal('/settings', { open: true })).path, '/settings/theme');
  assert.equal(model.rowAt(model.reveal('/wide', { open: true, before: '/wide/c' })).path, '/wide/c');
  assert.equal(model.rowAt(model.reveal('/wide', { open: true })).path, '/wide/d');
  model.reveal('/nestedTail/branch/leaf');
  assert.equal(model.rowAt(model.reveal('/nestedTail', { open: true })).path, '/nestedTail/branch/leaf');

  const filtered = createTreeModel({
    data,
    onlyRequired: true,
    requiredChildren: createChildPathIndex(['/settings', '/wide/a', '/wide/d']),
    forceExpand: new Set(['', '/settings', '/wide']),
  });
  assert.equal(filtered.rowAt(filtered.reveal('/settings', { open: true })).path, '/settings');
  assert.equal(filtered.rowAt(filtered.reveal('/wide', { open: true, before: '/wide/b' })).path, '/wide/d');
  assert.equal(filtered.rowAt(filtered.reveal('/wide', { open: true, before: '/wide/c' })).path, '/wide/d');
  filtered.update({ requiredChildren: createChildPathIndex(['/wide/a']) });
  assert.equal(filtered.rowAt(filtered.reveal('/wide', { open: true, before: '/wide/c' })).path, '/wide/a');
});

test('required paths retain object ordering and support escaped, empty and prototype-like keys', () => {
  const data = JSON.parse('{"last":0,"9":9,"2":2,"a/b":{"~1":1,"":2},"__proto__":3}');
  const paths = ['/a~1b/~01', '/a~1b/', '/__proto__', '/9'];
  const model = createTreeModel({ data, onlyRequired: true, requiredChildren: createChildPathIndex(paths), forceExpand: new Set(['/a~1b']) });
  assert.deepEqual(entryPaths(model), ['', '/9', '/a~1b', '/a~1b/~01', '/a~1b/', '/__proto__']);
  for (const path of paths) assert.equal(model.rowAt(model.indexOf(path)).path, path);
  assert.equal(model.indexOf('/last'), -1);
  model.update({ onlyRequired: false });
  assert.deepEqual(entryPaths(model), ['', '/2', '/9', '/last', '/a~1b', '/a~1b/~01', '/a~1b/', '/__proto__']);
});

test('deep automatic expansion and navigation avoid recursive JavaScript calls', () => {
  let data = 'leaf';
  const depth = 3000;
  for (let i = 0; i < depth; i++) data = [data];
  const model = createTreeModel({ data, expandLevel: Infinity });
  assert.equal(model.rowCount, depth * 2 + 1);
  const path = '/0'.repeat(depth);
  assert.equal(model.rowAt(model.indexOf(path)).value, 'leaf');
  model.setOpen('/0', false);
  assert.equal(model.indexOf(path), -1);
  assert.equal(model.rowAt(model.reveal(path)).value, 'leaf');
});

test('cached object keys survive updates, navigation and repeated viewport access', () => {
  let enumerations = 0;
  const data = new Proxy({ a: 1, b: 2 }, { ownKeys(target) { enumerations++; return Reflect.ownKeys(target); } });
  const model = createTreeModel({ data });
  model.rowAt(1);
  model.rowAt(2);
  model.update({ expandLevel: Infinity });
  model.indexOf('/b');
  model.sizeOf(data);
  assert.equal(enumerations, 1);
});

test('virtual rendering bounds DOM and reaches values beyond browser scroll-height limits', () => withDom(async () => {
  const container = new Element();
  const tree = createVirtualTree(container, { request: makeRequest(Array(2_000_000).fill(7)) });
  await tree.ready;
  assert.ok(container.querySelectorAll('.entry').length <= 45);
  assert.equal(tree.rowCount, 2_000_002);
  assert.equal(await tree.reveal('/1999999'), true);
  tree.setCurrent('/1999999');
  const current = container.querySelector('.entry.current');
  assert.equal(current.dataset.path, '/1999999');
  assert.equal(current.querySelector('.v').textContent, '7');
  assert.ok(container.querySelectorAll('.entry').length <= 45);
  assert.ok(Number.parseFloat(container.children[0].style.height) <= 8_000_000);
  const layer = container.children[0].children[0];
  tree.destroy();
  assert.equal(container.children.length, 0);
  assert.equal(layer.children.length, 0, 'destroy must release rows even if a caller keeps the controller');
  assert.equal(tree.rowCount, 0);
  assert.equal(container.events.scroll, undefined);
}));

test('toggles notify once, programmatic synchronization does not recurse, and highlights follow paths', () => withDom(async () => {
  const changes = [];
  const container = new Element();
  const tree = createVirtualTree(container, {
    request: makeRequest({ parent: { value: 1 } }),
    highlights: new Set(['/parent/value']),
    decorations: new Map([['/parent/value', { type: 'changed' }]]),
    onToggle: (path, open) => changes.push([path, open]),
  });
  await tree.ready;
  const parent = container.querySelectorAll('.entry').find((entry) => entry.dataset.path === '/parent');
  parent.querySelector('.toggle').click();
  await settle();
  assert.deepEqual(changes, [['/parent', true]]);
  assert.equal(container.querySelector('.entry.highlight').dataset.path, '/parent/value');
  assert.equal(container.querySelector('.entry.diff-changed').dataset.path, '/parent/value');
  await tree.setOpen('/parent', false);
  assert.deepEqual(changes, [['/parent', true]]);
  assert.equal(container.querySelector('.entry.highlight'), null);
  tree.destroy();
}));

test('large string previews and precision-preserving numeric literals stay bounded', () => withDom(async () => {
  const container = new Element();
  const tree = createVirtualTree(container, {
    request: makeRequest(
      ['x'.repeat(10_000_000), 9007199254740992, -0, Infinity],
      { '/1': '9007199254740993', '/2': '-0', '/3': '9'.repeat(10000) },
    ),
  });
  await tree.ready;
  const values = container.querySelectorAll('.v').map((entry) => entry.textContent);
  assert.ok(values[0].length < 2100);
  assert.equal(values[1], '9007199254740993');
  assert.equal(values[2], '-0');
  assert.ok(values[3].endsWith('strTruncated'));
  assert.ok(values[3].length < 2100);
  tree.destroy();
}));

test('string and key previews never leave half of a surrogate pair', () => withDom(async () => {
  const container = new Element();
  const value = 'a'.repeat(1998) + '😀' + 'z'.repeat(20);
  const tree = createVirtualTree(container, { request: makeRequest({ [value]: value }) });
  await tree.ready;
  for (const element of [...container.querySelectorAll('.key'), ...container.querySelectorAll('.v')]) {
    const text = element.textContent.replace(/strTruncated$/, '');
    assert.ok(!/[\ud800-\udbff]$/.test(text));
  }
  tree.destroy();
}));

function activeEntry(container) {
  const id = container.getAttribute('aria-activedescendant');
  return container.querySelectorAll('.entry').find((entry) => entry.id === id);
}

async function press(container, key) {
  let prevented = false;
  container.events.keydown({ key, preventDefault() { prevented = true; } });
  assert.equal(prevented, true, `${key} must not also scroll the page`);
  await settle();
  return activeEntry(container)?.dataset.path;
}

test('virtual tree exposes sibling counts and levels while excluding decorative closing rows', () => withDom(async () => {
  const container = new Element();
  container.setAttribute('aria-label', 'Formatted JSON');
  const tree = createVirtualTree(container, {
    request: makeRequest({ first: 1, nested: { a: 2, b: 3 }, empty: [] }),
    expandLevel: Infinity,
  });
  await tree.ready;
  assert.equal(container.getAttribute('role'), 'tree');
  assert.equal(container.getAttribute('tabindex'), '0');
  assert.equal(container.getAttribute('aria-label'), 'Formatted JSON');
  const entries = container.querySelectorAll('.entry');
  for (const entry of entries) {
    if (entry.classList.contains('virtual-close')) {
      assert.equal(entry.getAttribute('aria-hidden'), 'true');
      assert.equal(entry.getAttribute('role'), null);
    } else {
      assert.equal(entry.getAttribute('role'), 'treeitem');
      assert.equal(entry.getAttribute('tabindex'), null, 'the tree has one Tab stop');
    }
  }
  const nested = entries.find((entry) => entry.dataset.path === '/nested');
  assert.equal(nested.getAttribute('aria-level'), '2');
  assert.equal(nested.getAttribute('aria-posinset'), '2');
  assert.equal(nested.getAttribute('aria-setsize'), '3');
  assert.equal(nested.getAttribute('aria-expanded'), 'true');
  assert.ok(nested.getAttribute('aria-label').startsWith('nested: '));
  const b = entries.find((entry) => entry.dataset.path === '/nested/b');
  assert.equal(b.getAttribute('aria-level'), '3');
  assert.equal(b.getAttribute('aria-posinset'), '2');
  assert.equal(b.getAttribute('aria-setsize'), '2');
  assert.equal(b.getAttribute('aria-expanded'), null);
  const empty = entries.find((entry) => entry.dataset.path === '/empty');
  assert.equal(empty.getAttribute('aria-expanded'), null, 'empty containers have no child nodes');
  await tree.update({ onlyRequired: true, requiredChildren: createChildPathIndex(['/nested/b']) });
  const filtered = container.querySelectorAll('.entry').find((entry) => entry.dataset.path === '/nested/b');
  assert.equal(filtered.getAttribute('aria-posinset'), '1');
  assert.equal(filtered.getAttribute('aria-setsize'), '1');
  tree.destroy();
  assert.equal(container.getAttribute('role'), null);
  assert.equal(container.getAttribute('tabindex'), null);
  assert.equal(container.getAttribute('aria-activedescendant'), null);
  assert.equal(container.getAttribute('aria-label'), 'Formatted JSON');
}));

test('keyboard navigation expands nodes, visits children and siblings, and skips closing brackets', () => withDom(async () => {
  const changes = [];
  const container = new Element();
  const tree = createVirtualTree(container, {
    request: makeRequest({ parent: { leaf: 1 }, last: 2 }),
    onToggle: (...args) => changes.push(args),
  });
  await tree.ready;
  assert.equal(activeEntry(container).dataset.path, '');
  assert.equal(await press(container, 'ArrowRight'), '/parent');
  assert.equal(await press(container, 'ArrowRight'), '/parent', 'opening keeps focus on the parent');
  assert.equal(activeEntry(container).getAttribute('aria-expanded'), 'true');
  assert.equal(await press(container, 'ArrowRight'), '/parent/leaf');
  assert.equal(await press(container, 'ArrowRight'), '/parent/leaf', 'leaf nodes do not expand');
  assert.equal(await press(container, 'ArrowDown'), '/last');
  assert.equal(await press(container, 'ArrowUp'), '/parent/leaf');
  assert.equal(await press(container, 'ArrowLeft'), '/parent');
  assert.equal(await press(container, 'ArrowLeft'), '/parent');
  assert.equal(activeEntry(container).getAttribute('aria-expanded'), 'false');
  assert.equal(await press(container, 'Enter'), '/parent');
  assert.equal(activeEntry(container).getAttribute('aria-expanded'), 'true');
  assert.equal(await press(container, ' '), '/parent');
  assert.equal(activeEntry(container).getAttribute('aria-expanded'), 'false');
  assert.equal(await press(container, 'End'), '/last');
  assert.equal(await press(container, 'ArrowDown'), '/last');
  assert.equal(await press(container, 'Home'), '');
  assert.equal(await press(container, 'ArrowUp'), '');
  assert.deepEqual(changes, [['/parent', true], ['/parent', false], ['/parent', true], ['/parent', false]]);
  tree.destroy();
  assert.equal(container.events.keydown, undefined);
  assert.equal(container.events.focus, undefined);
}));

test('virtual scrolling keeps the active descendant mounted and keyboard focus on the tree', () => withDom(async () => {
  const container = new Element();
  container.focus = () => { document.activeElement = container; };
  const tree = createVirtualTree(container, { request: makeRequest(Array(2_000_000).fill(7)) });
  await tree.ready;
  container.focus();
  const originalId = container.getAttribute('aria-activedescendant');
  container.scrollTop = 4_000_000;
  tree.refresh();
  await settle();
  assert.equal(container.getAttribute('aria-activedescendant'), originalId);
  assert.equal(activeEntry(container).dataset.path, '');
  assert.ok(activeEntry(container).classList.contains('virtual-active-outside'));
  assert.ok(container.querySelectorAll('.entry').length <= 46, 'pinning costs at most one row');
  assert.equal(document.activeElement, container);
  assert.equal(await press(container, 'End'), '/1999999');
  assert.ok(!activeEntry(container).classList.contains('virtual-active-outside'));
  assert.equal(activeEntry(container).getAttribute('aria-posinset'), '2000000');
  assert.equal(activeEntry(container).getAttribute('aria-setsize'), '2000000');
  assert.equal(document.activeElement, container);
  assert.equal(await press(container, 'ArrowUp'), '/1999998');
  tree.destroy();
}));

test('collapsing or filtering an active descendant falls back to a visible ancestor', () => withDom(async () => {
  const container = new Element();
  const tree = createVirtualTree(container, { request: makeRequest({ parent: { leaf: 1 }, other: 2 }) });
  await tree.ready;
  await tree.reveal('/parent/leaf');
  tree.setCurrent('/other');
  assert.equal(activeEntry(container).dataset.path, '/parent/leaf', 'search decoration is independent of keyboard focus');
  await tree.setOpen('/parent', false);
  assert.equal(activeEntry(container).dataset.path, '/parent');
  await tree.update({ onlyRequired: true, requiredChildren: createChildPathIndex(['/other']) });
  assert.equal(activeEntry(container).dataset.path, '');
  tree.destroy();
  const empty = createVirtualTree(container, { request: makeRequest(undefined) });
  await empty.ready;
  assert.equal(container.getAttribute('aria-activedescendant'), null);
  empty.destroy();
}));

test('pointer activation preserves value text nodes and native selections after virtual scrolling', () => withDom(async () => {
  const container = new Element();
  container.focus = () => {
    if (document.activeElement === container) return;
    document.activeElement = container;
    container.events.focus?.();
  };
  const tree = createVirtualTree(container, { request: makeRequest(Array(1000).fill('selectable')) });
  await tree.ready;
  container.scrollTop = 1200;
  tree.refresh();
  await settle();
  const entry = container.querySelectorAll('.entry').find((item) => item.dataset.path === '/50');
  const row = entry.querySelector('.row');
  const value = entry.querySelector('.v');
  row.dispatchEvent({ type: 'pointerdown' });
  container.focus();
  value.dispatchEvent({ type: 'click' });
  assert.equal(activeEntry(container), entry);
  assert.equal(activeEntry(container).querySelector('.v'), value, 'pointer focus must not replace selectable text');
  document.getSelection = () => ({ isCollapsed: false, anchorNode: value, focusNode: value });
  value.dispatchEvent({ type: 'click' });
  assert.equal(activeEntry(container).querySelector('.v'), value);
  assert.equal(container.scrollTop, 1200, 'clicking a visible row must not jump back to the old active row');
  tree.destroy();
}));

test('incremental toggles retain untouched sibling descriptors and skip decorative rebuilds', () => {
  const model = createTreeModel({ data: { first: { value: 1 }, second: { value: 2 } }, expandLevel: Infinity });
  const second = model.rowAt(model.indexOf('/second'));
  model.setOpen('/first', false);
  assert.equal(model.rowAt(model.indexOf('/second')), second);
  model.setOpen('/first', true);
  assert.equal(model.rowAt(model.indexOf('/second')), second);
  model.update({ highlights: new Set(['/first']) });
  assert.equal(model.rowAt(model.indexOf('/second')), second);
});

test('incremental rows match full rebuilds after random toggles and reveals', () => {
  const data = JSON.parse('{"": [{"a/b":{"~":1,"":2}}, [3, {"nested":[4,5]}]], "2":{"x":[{"y":6},7]}, "__proto__":{"z":8}, "last":[[],{}]}');
  const all = createTreeModel({ data, expandLevel: Infinity });
  const paths = entryPaths(all);
  const forced = new Set(['/2', '/2/x']);
  const requiredChildren = createChildPathIndex(paths.filter((_, i) => i % 2));
  let randomState = 0x12345678;
  const random = () => { randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5; return randomState >>> 0; };
  for (const expandLevel of [0, 1, 2, Infinity]) for (const onlyRequired of [false, true]) {
    const expanded = new Set();
    const collapsed = new Set();
    const options = { data, expandLevel, onlyRequired, forceExpand: forced, requiredChildren };
    const incremental = createTreeModel(options);
    for (let step = 0; step < 300; step++) {
      const path = paths[random() % paths.length];
      if (random() % 4 === 0) {
        const before = createTreeModel({ ...options, expanded: new Set(expanded), collapsed: new Set(collapsed) });
        if (before.indexOf(path) < 0) {
          let ancestor = path;
          while (ancestor !== '') {
            ancestor = ancestor.slice(0, ancestor.lastIndexOf('/'));
            expanded.add(ancestor);
            collapsed.delete(ancestor);
          }
        }
        incremental.reveal(path);
      } else {
        const open = !!(random() % 2);
        incremental.setOpen(path, open);
        if (open) { expanded.add(path); collapsed.delete(path); }
        else { expanded.delete(path); collapsed.add(path); }
      }
      const rebuilt = createTreeModel({ ...options, expanded: new Set(expanded), collapsed: new Set(collapsed) });
      assert.equal(incremental.rowCount, rebuilt.rowCount, `row count at level ${expandLevel}, filtered ${onlyRequired}, step ${step}`);
      assert.deepEqual(rows(incremental), rows(rebuilt));
      for (const candidate of paths) assert.equal(incremental.indexOf(candidate), rebuilt.indexOf(candidate), candidate);
    }
  }
});

test('reopening a large subtree does not exceed the function argument limit', () => {
  const model = createTreeModel({ data: Array.from({ length: 50_000 }, (_, value) => ({ value })), expandLevel: Infinity });
  const count = model.rowCount;
  model.setOpen('', false);
  assert.equal(model.rowCount, 1);
  model.setOpen('', true);
  assert.equal(model.rowCount, count);
  assert.equal(model.rowAt(model.indexOf('/49999/value')).value, 49_999);
});

test('wide-object indexOf and sibling collapse range merging stay exact and reuse DOM rows on scroll', () => withDom(async () => {
  const wide = {};
  for (let i = 0; i < 200; i++) wide[`key_${i}`] = { nested: i };
  const model = createTreeModel({ data: wide });
  assert.equal(model.indexOf('/key_199'), 200);
  assert.equal(model.indexOf('/key_0'), 1);
  assert.equal(model.indexOf('/missing'), -1);
  // Open three consecutive siblings then close in middle-first and edge orders to test range merges.
  for (const key of ['/key_10', '/key_11', '/key_12']) model.setOpen(key, true);
  assert.equal(model.rowCount, 202 + 6);
  model.setOpen('/key_11', false);
  model.setOpen('/key_10', false);
  model.setOpen('/key_12', false);
  assert.equal(model.rowCount, 202);
  assert.equal(model.rowAt(model.indexOf('/key_11')).path, '/key_11');
  assert.equal(model.rowAt(model.indexOf('/key_199')).path, '/key_199');

  const container = new Element();
  const tree = createVirtualTree(container, { request: makeRequest(Array.from({ length: 200 }, (_, i) => i)) });
  await tree.ready;
  const before = container.querySelectorAll('.entry').find((entry) => entry.dataset.path === '/10');
  // Micro-scroll inside the same row range keeps the exact mounted DOM node.
  container.scrollTop = 4;
  tree.refresh();
  assert.strictEqual(container.querySelectorAll('.entry').find((entry) => entry.dataset.path === '/10'), before);
  // Shifting the viewport slightly still reuses overlapping DOM nodes.
  container.scrollTop = 96;
  tree.refresh();
  assert.strictEqual(container.querySelectorAll('.entry').find((entry) => entry.dataset.path === '/10'), before);
  tree.destroy();
}));

test('layer ResizeObserver defers spacer minWidth writes to the next frame without synchronous relayout', () => withDom(async () => {
  const previousRO = globalThis.ResizeObserver;
  const previousRAF = globalThis.requestAnimationFrame;
  const previousCAF = globalThis.cancelAnimationFrame;
  const observers = [];
  const frames = new Map();
  let nextFrameId = 1;
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.disconnected = true; }
  };
  globalThis.requestAnimationFrame = (callback) => { const id = nextFrameId++; frames.set(id, callback); return id; };
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
  try {
    const container = new Element();
    container.clientWidth = 480;
    const tree = createVirtualTree(container, { request: makeRequest({ nested: { wide: 'x'.repeat(200) } }) });
    await tree.ready;
    const spacer = container.children[0];
    const layerObserver = observers.find((observer) => observer.targets.includes(spacer.children[0]));
    assert.ok(layerObserver);
    // Fits within viewport (even with subpixel rounding): must not introduce a horizontal scrollbar.
    layerObserver.callback([{ contentRect: { width: 480.4 } }]);
    for (const callback of [...frames.values()]) callback();
    frames.clear();
    assert.equal(spacer.style.minWidth, '');

    // Overflowing layer must NOT mutate spacer synchronously inside ResizeObserver.
    layerObserver.callback([{ contentRect: { width: 1104.4 } }]);
    assert.equal(spacer.style.minWidth, '');
    assert.equal(frames.size, 1);
    for (const callback of [...frames.values()]) callback();
    frames.clear();
    assert.equal(spacer.style.minWidth, '1104.4px');

    // Collapsing resets horizontal extent and cancels any queued width frame.
    layerObserver.callback([{ contentRect: { width: 1400 } }]);
    const collapsing = tree.setOpen('', false);
    assert.equal(spacer.style.minWidth, '');
    assert.equal(frames.size, 0);
    await collapsing;
    tree.destroy();
  } finally {
    globalThis.ResizeObserver = previousRO;
    globalThis.requestAnimationFrame = previousRAF;
    globalThis.cancelAnimationFrame = previousCAF;
  }
}));
