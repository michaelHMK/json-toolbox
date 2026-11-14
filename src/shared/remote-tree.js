import { createVirtualTree } from './virtual-tree.js';

const CACHE_ROWS = 1024;
const WINDOW_ROWS = 256;
const MODEL_OPTIONS = ['expandLevel', 'expanded', 'collapsed', 'forceExpand', 'onlyRequired', 'requiredChildren'];

// Only window descriptors live in this model. The parsed document, container
// index, expansion state and path resolution remain in the Worker snapshot.
function createRemoteModel(request) {
  let rowCount = 0;
  let revision = 0;
  let destroyed = false;
  let initialized = false;
  let options = { expanded: new Set(), collapsed: new Set() };
  let active = { path: null, index: -1 };
  const rows = new Map();
  const pendingOpen = new Map();
  let loading = null;

  function snapshotOptions() {
    return { ...options, expanded: new Set(options.expanded), collapsed: new Set(options.collapsed) };
  }

  function rememberOpen(path, open) {
    if (open) { options.expanded.add(path); options.collapsed.delete(path); }
    else { options.expanded.delete(path); options.collapsed.add(path); }
  }

  function remember(index, row) {
    if (index < 0 || !row) return;
    rows.delete(index);
    rows.set(index, row);
    while (rows.size > CACHE_ROWS) {
      const oldest = rows.keys().next().value;
      if (oldest === active.index) {
        const pinned = rows.get(oldest);
        rows.delete(oldest);
        rows.set(oldest, pinned);
      } else rows.delete(oldest);
    }
  }

  function install(result, replace, adoptActive) {
    rowCount = result.rowCount;
    if (replace) { rows.clear(); pendingOpen.clear(); }
    if (adoptActive) active = { path: result.activePath ?? null, index: result.activeIndex ?? -1 };
    for (let offset = 0; offset < result.rows.length; offset++) remember(result.start + offset, result.rows[offset]);
    remember(result.activeIndex, result.activeRow);
  }

  async function run(operation, payload = {}, mutate = false) {
    if (destroyed) return false;
    const expected = mutate ? ++revision : revision;
    try {
      const response = await request({ operation, options: snapshotOptions(),
        activePath: active.path, activeIndex: active.index, ...payload });
      if (destroyed || expected !== revision || !response?.ok) return false;
      install(response.result, mutate, operation !== 'rows');
      return response.result;
    } catch {
      // The page's request boundary displays Worker errors. A failed window
      // must leave the last usable view intact and must not create a retry loop.
      return false;
    }
  }

  return {
    get rowCount() { return rowCount; },
    get active() { return active; },
    rowAt: (index) => rows.get(index) ?? null,
    openState: (path, fallback) => pendingOpen.get(path) ?? fallback,
    // Remote descriptors carry their size, so the renderer never enumerates
    // an object graph on the UI thread.
    sizeOf: () => 0,
    setActive(path, index) { active = { path, index }; },
    update(next) {
      const changes = {};
      for (const key of MODEL_OPTIONS) if (Object.hasOwn(next, key)) changes[key] = next[key];
      if (initialized && !Object.keys(changes).length) return;
      options = { ...options, ...changes };
      initialized = true;
      return run('update', { start: 0, count: WINDOW_ROWS }, true);
    },
    setOpen(path, open) {
      rememberOpen(path, open);
      pendingOpen.set(path, open);
      return run('setOpen', { path, open, count: WINDOW_ROWS }, true);
    },
    reveal(path) {
      return run('reveal', { path, count: WINDOW_ROWS }, true)
        .then((result) => {
          if (result === false) return false;
          const index = result.revealIndex ?? -1;
          if (index >= 0) {
            let ancestor = path;
            while (ancestor !== '') {
              ancestor = ancestor.slice(0, ancestor.lastIndexOf('/'));
              rememberOpen(ancestor, true);
            }
          }
          return index;
        });
    },
    move(index, step) {
      return run('move', { index, step, count: WINDOW_ROWS }, true)
        .then((result) => result === false ? false : result.revealIndex ?? -1);
    },
    ensureRange(start, end) {
      if (destroyed || start >= end) return null;
      let missing = -1;
      for (let index = start; index < end; index++) if (!rows.has(index)) { missing = index; break; }
      if (missing < 0) return null;
      if (loading?.revision === revision) return loading.promise;
      // Center a larger window around the viewport for smooth nearby scrolling.
      const from = Math.max(0, missing - Math.max(0, Math.floor((WINDOW_ROWS - (end - start)) / 2)));
      const current = { revision, promise: null };
      current.promise = run('rows', { start: from, count: WINDOW_ROWS }).then((response) => response !== false)
        .finally(() => { if (loading === current) loading = null; });
      loading = current;
      return current.promise;
    },
    destroy() {
      destroyed = true;
      revision++;
      rows.clear();
      pendingOpen.clear();
      loading = null;
      rowCount = 0;
      active = { path: null, index: -1 };
    },
  };
}

/**
 * Same UI API as createVirtualTree, with async update/setOpen/reveal and ready.
 * request supplies the page's snapshot identity and handles recoverable errors.
 */
export function createRemoteTree(container, { request, ...initial }) {
  const model = createRemoteModel(request);
  const tree = createVirtualTree(container, { ...initial, model });
  tree.ready = tree.update(initial);
  return tree;
}
