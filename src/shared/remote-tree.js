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
  let activeVersion = 0;
  const rows = new Map();
  const pendingOpen = new Map();
  let loading = null;
  let recovery = null;
  const pendingOperations = new Map();

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

  function restoreModel() {
    if (recovery) return recovery;
    const pending = Promise.resolve(request({ operation: 'update', options: snapshotOptions(),
      activePath: active.path, activeIndex: active.index, start: 0, count: WINDOW_ROWS }))
      .finally(() => { if (recovery === pending) recovery = null; });
    recovery = pending;
    return pending;
  }

  async function send(operation, payload, expected) {
    const dispatch = () => {
      const selected = activeVersion;
      return Promise.resolve(request({ operation, activePath: active.path, activeIndex: active.index, ...payload }))
        .then((response) => ({ response, selected }));
    };
    let reply = await dispatch();
    if (!destroyed && expected === revision && reply.response?.code === 'TREE_MODEL_UNAVAILABLE') {
      const restored = await restoreModel();
      if (destroyed || expected !== revision || !restored?.ok) return null;
      // Configuration is sent once to recreate a missing Worker model. Normal
      // viewport, navigation and toggle messages contain only their operation.
      reply = await dispatch();
      reply.recovered = true;
    }
    return reply;
  }

  async function execute(operation, payload, mutate, expected) {
    const intendedSelection = activeVersion;
    try {
      const reply = await send(operation, payload, expected);
      const response = reply?.response;
      if (destroyed || expected !== revision || !response?.ok) return false;
      install(response.result, mutate || reply.recovered, intendedSelection === activeVersion);
      // Pointer activation is an independent user intention, not a structural
      // revision. Keep the valid expansion/filter result and resolve the latest
      // selected path against its new row indexes (falling back to an ancestor
      // if a collapse hid it), instead of accepting an old activeIndex.
      let selected = intendedSelection;
      while (selected !== activeVersion) {
        const resolved = await send('resolve', { start: response.result.start, count: WINDOW_ROWS }, expected);
        if (destroyed || expected !== revision || !resolved?.response?.ok) return false;
        selected = resolved.selected;
        install(resolved.response.result, resolved.recovered, selected === activeVersion);
      }
      return response.result;
    } catch {
      // The page's request boundary displays Worker errors. A failed window
      // must leave the last usable view intact and must not create a retry loop.
      return false;
    }
  }

  function run(operation, payload = {}, mutate = false) {
    if (destroyed) return Promise.resolve(false);
    const expected = mutate ? ++revision : revision;
    const pending = execute(operation, payload, mutate, expected);
    pendingOperations.set(pending, expected);
    pending.then(() => pendingOperations.delete(pending));
    return pending;
  }

  return {
    get rowCount() { return rowCount; },
    get active() { return active; },
    rowAt: (index) => rows.get(index) ?? null,
    openState: (path, fallback) => pendingOpen.get(path) ?? fallback,
    async whenSettled() {
      // Keyboard commands must not read a new row cache using the UI's old
      // index while a structural response is resolving a newer pointer path.
      // Superseded operations do not block the current model's navigation.
      while (!destroyed) {
        const current = [...pendingOperations].filter(([, version]) => version === revision).map(([pending]) => pending);
        if (!current.length) return;
        await Promise.all(current);
      }
    },
    // Remote descriptors carry their size, so the renderer never enumerates
    // an object graph on the UI thread.
    sizeOf: () => 0,
    setActive(path, index) { activeVersion++; active = { path, index }; },
    update(next) {
      const changes = {};
      for (const key of MODEL_OPTIONS) if (Object.hasOwn(next, key)) changes[key] = next[key];
      if (initialized && !Object.keys(changes).length) return;
      options = { ...options, ...changes };
      initialized = true;
      return run('update', { options: snapshotOptions(), start: 0, count: WINDOW_ROWS }, true);
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
    child(path) {
      return run('child', { path, count: WINDOW_ROWS }, true)
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
      recovery = null;
      pendingOperations.clear();
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
