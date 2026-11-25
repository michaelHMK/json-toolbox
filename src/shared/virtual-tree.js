import { MODEL_OPTIONS } from '../core/tree-model.js';
import { PREVIEW_LIMIT, previewPrefix } from '../core/preview.js';
import { t } from './i18n.js';

const isContainer = (value) => value !== null && typeof value === 'object';
const MAX_SCROLL_HEIGHT = 8_000_000;
const CACHE_ROWS = 1024;
const WINDOW_ROWS = 256;
const TREE_MODEL_OPTIONS = MODEL_OPTIONS.filter((key) => key !== 'data');
let nextTreeId = 0;

function span(className, text) {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

function literalPreview(text, length = text.length) {
  return length > PREVIEW_LIMIT ? previewPrefix(text) + t('strTruncated', [length.toLocaleString()]) : text;
}

function preview(value, length = typeof value === 'string' ? value.length : undefined) {
  if (typeof value === 'string') {
    const encoded = JSON.stringify(previewPrefix(value));
    if (length > PREVIEW_LIMIT || encoded.length > PREVIEW_LIMIT) {
      return previewPrefix(encoded) + t('strTruncated', [length.toLocaleString()]);
    }
    return encoded;
  }
  return literalPreview(String(value));
}

function patchChildren(parent, nextChildren) {
  if (!parent.children.length) {
    if (!nextChildren.length) return;
    const fragment = document.createDocumentFragment();
    for (const node of nextChildren) fragment.appendChild(node);
    parent.appendChild(fragment);
    return;
  }
  const keep = new Set(nextChildren);
  let reused = false;
  for (let i = parent.children.length - 1; i >= 0; i--) {
    const child = parent.children[i];
    if (keep.has(child)) reused = true;
    else child.remove();
  }
  if (!reused) {
    const fragment = document.createDocumentFragment();
    for (const node of nextChildren) fragment.appendChild(node);
    parent.replaceChildren(fragment);
    return;
  }
  for (let i = 0; i < nextChildren.length; i++) {
    const node = nextChildren[i];
    const current = parent.children[i];
    if (current === node) continue;
    if (current) current.before(node);
    else parent.appendChild(node);
  }
}

// Only bounded row descriptors live in the UI model. The parsed object graph,
// container index, expansion tree and path resolution stay in the Worker.
function createWindowedModel(request) {
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
    const pending = Promise.resolve(request({
      operation: 'update', options: snapshotOptions(),
      activePath: active.path, activeIndex: active.index, start: 0, count: WINDOW_ROWS,
    })).finally(() => { if (recovery === pending) recovery = null; });
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
    setActive(path, index) { activeVersion++; active = { path, index }; },
    update(next) {
      const changes = {};
      for (const key of TREE_MODEL_OPTIONS) if (Object.hasOwn(next, key)) changes[key] = next[key];
      if (initialized && !Object.keys(changes).length) return null;
      options = { ...options, ...changes };
      initialized = true;
      return run('update', { options: snapshotOptions(), start: 0, count: WINDOW_ROWS }, true);
    },
    setOpen(path, open) {
      rememberOpen(path, open);
      pendingOpen.set(path, open);
      return run('setOpen', { path, open, count: WINDOW_ROWS }, true);
    },
    reveal(path, { open = false, before = null } = {}) {
      const payload = open
        ? { path, open: true, before, count: WINDOW_ROWS }
        : { path, count: WINDOW_ROWS };
      return run('reveal', payload, true)
        .then((result) => {
          if (result === false) return false;
          const index = result.revealIndex ?? -1;
          if (index >= 0) {
            if (open) rememberOpen(path, true);
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
 * Worker-backed virtual JSON tree for all document sizes.
 * request supplies the page's snapshot identity and handles recoverable errors.
 * update replaces supplied options; refresh paints the viewport; reveal opens
 * ancestors and scrolls to a path; setOpen notifies onToggle only with
 * { notify: true }. Mutations return promises and window misses render
 * placeholders until their Worker window arrives.
 */
export function createVirtualTree(container, { request, ...initial } = {}) {
  let options = { rowHeight: 24, overscan: 12, highlights: new Set(), decorations: new Map(), ...initial };
  const model = createWindowedModel(request);
  let currentPath = null;
  let activationVersion = 0;
  let activePath = null;
  let activeIndex = -1;
  const treeId = `json-tree-${++nextTreeId}`;
  const itemId = (index) => `${treeId}-item-${index}`;
  const originalAttributes = new Map(['role', 'tabindex', 'aria-activedescendant'].map((name) => [name, container.getAttribute(name)]));
  let frame = null;
  let widthFrame = null;
  let pendingWidth = 0;
  let destroyed = false;
  let navigation = Promise.resolve();
  let maxWidth = 0;
  let lastRowHeight = null;
  let lastSpacerHeight = null;
  let lastLayerTop = null;
  let structureVersion = 0;
  let renderedVersion = -1;
  let renderedStart = -1;
  let renderedEnd = -1;
  let renderedPinned = -1;
  let mountedRows = new Map();
  let pinnedNode = null;
  const requestFrame = globalThis.requestAnimationFrame || ((callback) => setTimeout(callback, 0));
  const cancelFrame = globalThis.cancelAnimationFrame || clearTimeout;
  const spacer = document.createElement('div');
  spacer.className = 'virtual-tree-spacer';
  const layer = document.createElement('div');
  layer.className = 'virtual-tree-layer tree-root';
  spacer.appendChild(layer);
  container.replaceChildren(spacer);
  container.classList.add('virtual-tree');
  container.setAttribute('role', 'tree');
  container.setAttribute('tabindex', '0');

  function geometry() {
    const viewport = container.clientHeight || 480;
    const logicalHeight = model.rowCount * options.rowHeight;
    const physicalHeight = Math.min(MAX_SCROLL_HEIGHT, logicalHeight);
    const logicalRange = Math.max(0, logicalHeight - viewport);
    const physicalRange = Math.max(0, physicalHeight - viewport);
    const scale = physicalRange ? logicalRange / physicalRange : 1;
    return { viewport, physicalHeight, physicalRange, logicalRange, scale };
  }

  function resetHorizontalExtent() {
    if (widthFrame !== null) {
      cancelFrame(widthFrame);
      widthFrame = null;
    }
    pendingWidth = 0;
    maxWidth = 0;
    spacer.style.minWidth = '';
  }

  function flushWidth() {
    widthFrame = null;
    if (destroyed) return;
    const width = pendingWidth;
    pendingWidth = 0;
    const viewportWidth = container.clientWidth || 0;
    if (width > maxWidth && (!viewportWidth || width > viewportWidth + 0.5)) {
      maxWidth = width;
      spacer.style.minWidth = `${maxWidth}px`;
    }
  }

  function renderRow(descriptor, index) {
    const { value, key, path, depth, kind, open } = descriptor;
    const entry = document.createElement('div');
    entry.className = 'entry';
    entry.dataset.path = path;
    entry.dataset.index = String(index);
    entry.dataset.kind = kind;
    entry.style.paddingLeft = `${6 + depth * 20}px`;
    const row = document.createElement('div');
    row.className = 'row';
    entry.appendChild(row);
    if (kind === 'close') {
      entry.classList.add('virtual-close');
      entry.setAttribute('aria-hidden', 'true');
      row.classList.add('close-row');
      row.appendChild(span('toggle-spacer', ''));
      row.appendChild(span('punct', Array.isArray(value) ? ']' : '}'));
      return entry;
    }
    entry.id = itemId(index);
    entry.setAttribute('role', 'treeitem');
    entry.setAttribute('aria-level', String(depth + 1));
    entry.setAttribute('aria-posinset', String(descriptor.posInSet));
    entry.setAttribute('aria-setsize', String(descriptor.setSize));
    if (path === activePath) entry.classList.add('keyboard-active');
    if (options.highlights.has(path)) entry.classList.add('highlight');
    const decoration = options.decorations.get(path);
    if (decoration) entry.classList.add('diff-' + (typeof decoration === 'string' ? decoration : decoration.type));
    if (path === currentPath) entry.classList.add('current');
    const containerValue = isContainer(value);
    const toggle = span(containerValue ? 'toggle' : 'toggle-spacer', containerValue ? open ? '▾' : '▸' : '');
    toggle.setAttribute('aria-hidden', 'true');
    row.appendChild(toggle);
    if (key !== null) {
      row.appendChild(span('key', descriptor.isIndex ? String(key) : preview(String(key), descriptor.keyLength)));
      row.appendChild(span('punct', ': '));
    }
    if (containerValue) {
      entry.dataset.container = '1';
      entry.dataset.open = open ? '1' : '0';
      const isArray = Array.isArray(value);
      row.appendChild(span('punct', isArray ? '[' : '{'));
      const size = descriptor.size ?? 0;
      const summaryText = t(isArray ? 'treeSummaryItems' : 'treeSummaryKeys', [size.toLocaleString()]);
      const summary = span('summary', summaryText);
      entry.setAttribute('aria-label', key === null ? summaryText : `${literalPreview(String(key), descriptor.keyLength)}: ${summaryText}`);
      if (size) entry.setAttribute('aria-expanded', String(open));
      if (!open) {
        row.appendChild(summary);
        row.appendChild(span('punct', isArray ? ']' : '}'));
      }
    } else {
      const type = value === null ? 'null' : typeof value === 'boolean' ? 'bool' : typeof value;
      const literal = descriptor.literal;
      row.appendChild(span('v ' + type, literal === undefined ? preview(value, descriptor.valueLength)
        : literalPreview(String(literal), descriptor.literalLength)));
    }
    return entry;
  }

  function createPlaceholder() {
    const placeholder = document.createElement('div');
    placeholder.className = 'entry virtual-placeholder';
    placeholder.setAttribute('aria-hidden', 'true');
    return placeholder;
  }

  function onLayerPointerDown(event) {
    const entry = event.target?.closest?.('.entry');
    if (!entry || entry.classList.contains('virtual-placeholder') || entry.dataset.kind === 'close') return;
    // Set the active row before the browser focuses the tree on pointer-down.
    setActive(entry.dataset.path, Number(entry.dataset.index));
  }

  function onLayerClick(event) {
    const target = event.target;
    const entry = target?.closest?.('.entry');
    if (!entry || entry.classList.contains('virtual-placeholder')) return;
    const path = entry.dataset.path;
    if (entry.dataset.kind === 'close') {
      activationVersion++;
      activePath = path;
      model.setActive(path, -1);
      void setOpen(path, false, { notify: true });
      container.focus({ preventScroll: true });
      return;
    }
    const index = Number(entry.dataset.index);
    if (entry.dataset.container === '1') {
      const open = entry.dataset.open === '1';
      const flip = () => {
        setActive(path, index);
        void setOpen(path, !model.openState(path, open), { notify: true });
        container.focus({ preventScroll: true });
      };
      if (target.classList?.contains('toggle') || target.classList?.contains('summary')) {
        flip();
        return;
      }
      if (hasTextSelection()) return;
      if (target.classList?.contains('row') || target.classList?.contains('punct')) flip();
      else {
        setActive(path, index);
        container.focus({ preventScroll: true });
      }
      return;
    }
    if (hasTextSelection()) return;
    setActive(path, index);
    container.focus({ preventScroll: true });
  }

  function syncActiveAttribute(hasActive) {
    if (hasActive) container.setAttribute('aria-activedescendant', itemId(activeIndex));
    else container.removeAttribute('aria-activedescendant');
  }

  function refresh() {
    if (destroyed) return;
    const g = geometry();
    if (lastRowHeight !== options.rowHeight) {
      container.style.setProperty?.('--tree-row-height', `${options.rowHeight}px`);
      lastRowHeight = options.rowHeight;
    }
    if (lastSpacerHeight !== g.physicalHeight) {
      spacer.style.height = `${g.physicalHeight}px`;
      lastSpacerHeight = g.physicalHeight;
    }
    const scrollTop = Math.min(Math.max(0, container.scrollTop || 0), g.physicalRange);
    if (container.scrollTop !== scrollTop) container.scrollTop = scrollTop;
    const logicalTop = scrollTop * g.scale;
    const start = Math.max(0, Math.floor(logicalTop / options.rowHeight) - options.overscan);
    const end = Math.min(model.rowCount, Math.ceil((logicalTop + g.viewport) / options.rowHeight) + options.overscan);
    const loading = model.ensureRange(start, end);
    if (loading) loading.then((changed) => {
      if (changed && !destroyed) {
        structureVersion++;
        restoreActive();
        refresh();
      }
    });
    const nextLayerTop = scrollTop - logicalTop + start * options.rowHeight;
    if (lastLayerTop !== nextLayerTop) {
      layer.style.top = `${nextLayerTop}px`;
      lastLayerTop = nextLayerTop;
    }
    const activeDescriptor = activeIndex >= 0 ? model.rowAt(activeIndex) : null;
    const nextPinned = activeDescriptor && (activeIndex < start || activeIndex >= end) ? activeIndex : -1;
    if (renderedVersion === structureVersion && renderedStart === start && renderedEnd === end && renderedPinned === nextPinned) {
      syncActiveAttribute(Boolean(activeDescriptor));
      return;
    }

    const canReuse = renderedVersion === structureVersion;
    const nextMounted = new Map();
    const nextChildren = [];

    // Keep the active descendant mounted when wheel scrolling recycles its row.
    // This costs one extra row, independent of the size or depth of the JSON.
    let nextPinnedNode = null;
    if (nextPinned >= 0) {
      if (canReuse && pinnedNode?.index === nextPinned) {
        nextPinnedNode = pinnedNode;
      } else {
        const entry = renderRow(activeDescriptor, nextPinned);
        entry.classList.add('virtual-active-outside');
        nextPinnedNode = { index: nextPinned, entry };
      }
      nextPinnedNode.entry.classList.toggle('keyboard-active', nextPinnedNode.entry.dataset.path === activePath);
      nextPinnedNode.entry.classList.toggle('current', nextPinnedNode.entry.dataset.path === currentPath);
    }

    if (nextPinnedNode && nextPinned < start) nextChildren.push(nextPinnedNode.entry);
    for (let index = start; index < end; index++) {
      const descriptor = model.rowAt(index);
      const existing = canReuse ? mountedRows.get(index) : null;
      if (existing && Boolean(descriptor) === !existing.placeholder) {
        const entry = existing.entry;
        if (!existing.placeholder && entry.dataset.kind !== 'close') {
          entry.classList.toggle('keyboard-active', entry.dataset.path === activePath);
          entry.classList.toggle('current', entry.dataset.path === currentPath);
        }
        nextMounted.set(index, existing);
        nextChildren.push(entry);
      } else if (descriptor) {
        const entry = renderRow(descriptor, index);
        nextMounted.set(index, { entry, placeholder: false });
        nextChildren.push(entry);
      } else {
        const placeholder = createPlaceholder();
        nextMounted.set(index, { entry: placeholder, placeholder: true });
        nextChildren.push(placeholder);
      }
    }
    if (nextPinnedNode && nextPinned >= end) nextChildren.push(nextPinnedNode.entry);

    patchChildren(layer, nextChildren);
    mountedRows = nextMounted;
    pinnedNode = nextPinnedNode;
    renderedVersion = structureVersion;
    renderedStart = start;
    renderedEnd = end;
    renderedPinned = nextPinned;
    syncActiveAttribute(Boolean(activeDescriptor));
  }

  function schedule() {
    if (frame !== null || destroyed) return;
    frame = requestFrame(() => { frame = null; refresh(); });
  }

  async function update(next = {}) {
    resetHorizontalExtent();
    options = { ...options, ...next };
    const pending = model.update(next);
    if (pending) {
      const result = await pending;
      if (destroyed || result === false) return false;
    }
    if (destroyed) return false;
    structureVersion++;
    restoreActive();
    refresh();
    return true;
  }

  async function setOpen(path, open, { notify = false } = {}) {
    if (!open) resetHorizontalExtent();
    const pending = model.setOpen(path, open);
    // Synchronize paired trees for every user intention, including quick
    // successive clicks whose older rendering response is superseded.
    if (notify) options.onToggle?.(path, open);
    const result = await pending;
    if (destroyed || result === false) return false;
    structureVersion++;
    restoreActive();
    refresh();
    ensureActiveVisible();
    return true;
  }

  async function navigateResult(pending, apply) {
    const selected = activationVersion;
    const value = await pending;
    if (destroyed || value === false) return false;
    if (selected !== activationVersion) {
      structureVersion++;
      restoreActive();
      refresh();
      ensureActiveVisible();
      return true;
    }
    return apply(value);
  }

  function reveal(path, revealOptions) {
    return navigateResult(model.reveal(path, revealOptions), (index) => {
      structureVersion++;
      return showPath(model.active.path ?? path, index);
    });
  }

  function showPath(path, index) {
    if (index < 0) return false;
    activePath = path;
    activeIndex = index;
    model.setActive(path, index);
    const g = geometry();
    const logicalTop = Math.max(0, Math.min(g.logicalRange, index * options.rowHeight - (g.viewport - options.rowHeight) / 2));
    // A reveal can be the first response of an asynchronous tree (superseding
    // its initial update). Grow the physical scroller before assigning its
    // position, otherwise browsers clamp that assignment to the old height.
    spacer.style.height = `${g.physicalHeight}px`;
    lastSpacerHeight = g.physicalHeight;
    container.scrollTop = logicalTop / g.scale;
    refresh();
    // Nested indentation can put the actual key/value thousands of pixels to
    // the right, even though the full-width entry intersects the viewport.
    const viewport = container.getBoundingClientRect?.();
    const entry = [...layer.children].find((row) => row.dataset.path === path && !row.classList.contains('virtual-close'));
    if (viewport && container.clientWidth && entry) {
      const key = entry.querySelector('.key');
      const value = entry.querySelector('.v');
      const first = entry.querySelector('.toggle') || key || value;
      const last = value || key || first;
      if (first && last) {
        const left = first.getBoundingClientRect().left;
        const right = last.getBoundingClientRect().right;
        const visibleLeft = viewport.left + container.clientLeft + 8;
        const visibleRight = viewport.left + container.clientLeft + container.clientWidth - 8;
        if (left < visibleLeft || right - left > visibleRight - visibleLeft) {
          container.scrollLeft += left - visibleLeft;
        } else if (right > visibleRight) {
          container.scrollLeft += right - visibleRight;
        }
      }
    }
    return true;
  }

  function hasTextSelection() {
    const selection = document.getSelection?.();
    return selection && !selection.isCollapsed
      && (container.contains(selection.anchorNode) || container.contains(selection.focusNode));
  }

  function setActive(path, index) {
    activationVersion++;
    activePath = path;
    activeIndex = index;
    model.setActive(path, index);
    // Pointer activation must not replace text nodes: doing so clears the
    // browser's text selection, including double-click selection of a value.
    for (const entry of [...layer.children]) {
      if (entry.classList.contains('virtual-active-outside')) {
        entry.remove();
        pinnedNode = null;
        renderedPinned = -1;
      } else {
        entry.classList.toggle('keyboard-active', entry.id === itemId(index));
      }
    }
    container.setAttribute('aria-activedescendant', itemId(index));
  }

  function restoreActive() {
    activePath = model.active.path;
    activeIndex = model.active.index;
  }

  function moveActive(index, step) {
    return navigateResult(model.move(index, step), (next) => {
      structureVersion++;
      return next >= 0 ? showPath(model.active.path, next) : false;
    });
  }

  function navigate(key) {
    if (destroyed || activeIndex < 0) return;
    const row = model.rowAt(activeIndex);
    if (!row) return;
    const expandable = isContainer(row.value) && (row.size ?? 0) > 0;
    switch (key) {
      case 'ArrowDown': return moveActive(activeIndex + 1, 1);
      case 'ArrowUp': return moveActive(activeIndex - 1, -1);
      case 'Home': return moveActive(0, 1);
      case 'End': return moveActive(model.rowCount - 1, -1);
      case 'ArrowRight':
        if (expandable && !row.open) return setOpen(row.path, true, { notify: true });
        if (expandable) {
          return navigateResult(model.child(row.path), (index) => {
            structureVersion++;
            return index >= 0 ? showPath(model.active.path, index) : false;
          });
        }
        break;
      case 'ArrowLeft':
        if (expandable && row.open) return setOpen(row.path, false, { notify: true });
        if (row.path !== '') return reveal(row.path.slice(0, row.path.lastIndexOf('/')));
        break;
      case 'Enter':
      case ' ':
        if (expandable) return setOpen(row.path, !row.open, { notify: true });
        break;
    }
  }

  function keydown(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || activeIndex < 0) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    const selected = activationVersion;
    navigation = navigation.then(async () => {
      if (selected !== activationVersion || destroyed) return;
      await model.whenSettled();
      if (selected === activationVersion && !destroyed) {
        restoreActive();
        return navigate(event.key);
      }
    });
  }

  function ensureActiveVisible() {
    if (activeIndex < 0 || activePath === null) return;
    const g = geometry();
    const top = (container.scrollTop || 0) * g.scale;
    if (activeIndex * options.rowHeight < top || (activeIndex + 1) * options.rowHeight > top + g.viewport) {
      void reveal(activePath);
    }
  }

  function focus() {
    ensureActiveVisible();
  }

  function setCurrent(path) {
    if (currentPath === path) return;
    currentPath = path;
    for (const entry of layer.children) {
      entry.classList.toggle('current', entry.dataset.path === path && !entry.classList.contains('virtual-close'));
    }
  }

  function destroy() {
    destroyed = true;
    if (frame !== null) cancelFrame(frame);
    if (widthFrame !== null) cancelFrame(widthFrame);
    resizeObserver?.disconnect();
    layerObserver?.disconnect();
    layer.removeEventListener('pointerdown', onLayerPointerDown);
    layer.removeEventListener('click', onLayerClick);
    container.removeEventListener('scroll', schedule);
    container.removeEventListener('keydown', keydown);
    container.removeEventListener('focus', focus);
    for (const [name, value] of originalAttributes) {
      if (value === null) container.removeAttribute(name);
      else container.setAttribute(name, value);
    }
    mountedRows.clear();
    pinnedNode = null;
    layer.replaceChildren();
    spacer.replaceChildren();
    container.replaceChildren();
    container.classList.remove('virtual-tree');
    model.destroy();
    options = {};
    currentPath = null;
    activePath = null;
    activeIndex = -1;
  }

  layer.addEventListener('pointerdown', onLayerPointerDown);
  layer.addEventListener('click', onLayerClick);
  container.addEventListener('keydown', keydown);
  container.addEventListener('focus', focus);
  container.addEventListener('scroll', schedule, { passive: true });
  const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  resizeObserver?.observe(container);
  // Track content width after layout instead of forcing synchronous scrollWidth
  // reads during every scroll frame. Mutate spacer.style.minWidth in the next
  // animation frame so ResizeObserver never re-triggers within the same delivery.
  const layerObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((entries) => {
    if (destroyed) return;
    const width = entries[entries.length - 1]?.contentRect?.width || 0;
    if (width > maxWidth && width > pendingWidth) {
      pendingWidth = width;
      if (widthFrame === null) widthFrame = requestFrame(flushWidth);
    }
  });
  layerObserver?.observe(layer);
  refresh();
  const ready = update(initial);
  return { ready, update, refresh, setOpen, reveal, setCurrent, destroy, get rowCount() { return model.rowCount; } };
}
