import { appendJsonPath } from '../core/json-path.js';
import { createChildPathIndex, span } from './json-tree.js';
import { t } from './i18n.js';

const isContainer = (value) => value !== null && typeof value === 'object';
const decodeKey = (key) => key.replace(/~1/g, '/').replace(/~0/g, '~');
const PREVIEW_LIMIT = 2000;
const MAX_SCROLL_HEIGHT = 8_000_000;
let nextTreeId = 0;
const MODEL_OPTIONS = ['data', 'expandLevel', 'expanded', 'collapsed', 'forceExpand', 'onlyRequired', 'requiredChildren'];
const modelOptions = (options) => Object.fromEntries(MODEL_OPTIONS.filter((key) => Object.hasOwn(options, key)).map((key) => [key, options[key]]));

// Logical rows are compressed sibling ranges, not one allocation per value.
// The model has no DOM dependency; opening containers builds its index iteratively.
export function createTreeModel(initial = {}) {
  let options = {
    data: undefined, expandLevel: 1, expanded: new Set(), collapsed: new Set(),
    forceExpand: new Set(), onlyRequired: false, requiredChildren: new Map(),
    ...modelOptions(initial),
  };
  let keyCache = new WeakMap();
  let segments = [];
  let containers = new Map();
  let rowCount = 0;

  function keysOf(value) {
    if (Array.isArray(value)) return null;
    let keys = keyCache.get(value);
    if (!keys) keyCache.set(value, keys = Object.keys(value));
    return keys;
  }
  const openAt = (path, depth) => !options.collapsed.has(path)
    && (path === '' || options.expanded.has(path) || options.forceExpand.has(path) || depth < options.expandLevel);

  function keyAt(record, position) {
    const index = record.indices ? record.indices[position] : position;
    return record.keys ? record.keys[index] : index;
  }

  // Only requested object keys get an index. Building a million-entry key Map
  // to locate one search result would undo the savings from virtual rendering.
  function positionsFor(record, paths) {
    if (!paths?.size) return [];
    const indexes = [];
    if (record.keys) {
      const wanted = new Set([...paths].map((path) => decodeKey(path.slice(record.path.length + 1))));
      for (let i = 0; i < record.keys.length; i++) if (wanted.has(record.keys[i])) indexes.push(i);
    } else {
      for (const path of paths) {
        const key = path.slice(record.path.length + 1);
        const i = Number(key);
        if (Number.isInteger(i) && i >= 0 && i < record.value.length && String(i) === key) indexes.push(i);
      }
      indexes.sort((a, b) => a - b);
    }
    return indexes;
  }

  function emit(segment, count = 1) {
    segment.row = rowCount;
    segment.count = count;
    rowCount += count;
    segments.push(segment);
    return segment;
  }

  function build() {
    segments = [];
    containers = new Map();
    rowCount = 0;
    if (options.data === undefined) return;
    const expansionChildren = createChildPathIndex([...options.expanded, ...options.forceExpand]);

    function enter(value, key, path, depth, isIndex, posInSet = 1, setSize = 1) {
      const open = isContainer(value) && openAt(path, depth);
      const descriptor = { kind: 'entry', value, key, path, depth, isIndex, open, posInSet, setSize };
      const entry = emit({ kind: 'entry', descriptor });
      if (!open) return null;
      const record = { value, path, depth, keys: keysOf(value), indices: null, ranges: [], entryRow: entry.row };
      if (options.onlyRequired) record.indices = positionsFor(record, options.requiredChildren.get(path));
      record.length = record.indices ? record.indices.length : record.keys ? record.keys.length : value.length;
      record.opens = [];
      if (depth + 1 < options.expandLevel) {
        // Automatic expansion must inspect containers, but primitive siblings
        // still share one range and never acquire persistent paths/row objects.
        for (let position = 0; position < record.length; position++) {
          const childKey = keyAt(record, position);
          const child = value[childKey];
          if (!isContainer(child)) continue;
          const childPath = appendJsonPath(path, childKey);
          if (openAt(childPath, depth + 1)) record.opens.push({ position, key: childKey, value: child, path: childPath });
        }
      } else {
        const candidates = positionsFor(record, expansionChildren.get(path));
        let filteredIndex = 0;
        for (const index of candidates) {
          let position = index;
          if (record.indices) {
            while (filteredIndex < record.indices.length && record.indices[filteredIndex] < index) filteredIndex++;
            if (record.indices[filteredIndex] !== index) continue;
            position = filteredIndex;
          }
          const childKey = record.keys ? record.keys[index] : index;
          const child = value[childKey];
          const childPath = appendJsonPath(path, childKey);
          if (isContainer(child) && openAt(childPath, depth + 1)) record.opens.push({ position, key: childKey, value: child, path: childPath });
        }
      }
      record.next = 0;
      record.openIndex = 0;
      containers.set(path, record);
      return record;
    }

    const root = enter(options.data, null, '', 0, false);
    const stack = root ? [root] : [];
    while (stack.length) {
      const record = stack[stack.length - 1];
      const child = record.opens[record.openIndex];
      const end = child ? child.position : record.length;
      if (end > record.next) {
        record.ranges.push(emit({ kind: 'range', record, start: record.next }, end - record.next));
      }
      if (child) {
        record.next = child.position + 1;
        record.openIndex++;
        const nested = enter(child.value, child.key, child.path, record.depth + 1, record.keys === null, child.position + 1, record.length);
        if (nested) stack.push(nested);
      } else {
        emit({ kind: 'close', descriptor: { kind: 'close', value: record.value, path: record.path, depth: record.depth } });
        // Traversal scratch is not part of the persistent row index.
        record.opens = null;
        stack.pop();
      }
    }
  }

  function rowAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= rowCount) return null;
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (segments[mid].row + segments[mid].count <= index) lo = mid + 1;
      else hi = mid;
    }
    const segment = segments[lo];
    if (segment.kind !== 'range') return segment.descriptor;
    const { record } = segment;
    const key = keyAt(record, segment.start + index - segment.row);
    return {
      kind: 'entry', key, value: record.value[key], path: appendJsonPath(record.path, key),
      depth: record.depth + 1, isIndex: record.keys === null, open: false,
      posInSet: segment.start + index - segment.row + 1, setSize: record.length,
    };
  }

  function indexOf(path) {
    if (path === '') return rowCount ? 0 : -1;
    const opened = containers.get(path);
    if (opened) return opened.entryRow;
    const slash = path.lastIndexOf('/');
    const parent = containers.get(path.slice(0, slash));
    if (!parent) return -1;
    const key = decodeKey(path.slice(slash + 1));
    let position = parent.keys ? parent.keys.indexOf(key) : Number(key);
    if (!Number.isInteger(position) || position < 0 || (!parent.keys && String(position) !== key)) return -1;
    if (parent.indices) {
      let lo = 0;
      let hi = parent.indices.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (parent.indices[mid] < position) lo = mid + 1;
        else hi = mid;
      }
      if (parent.indices[lo] !== position) return -1;
      position = lo;
    }
    let lo = 0;
    let hi = parent.ranges.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const range = parent.ranges[mid];
      if (range.start + range.count <= position) lo = mid + 1;
      else hi = mid;
    }
    const range = parent.ranges[lo];
    return range && position >= range.start ? range.row + position - range.start : -1;
  }

  function update(next) {
    if (Object.hasOwn(next, 'data') && next.data !== options.data) keyCache = new WeakMap();
    options = { ...options, ...modelOptions(next) };
    build();
  }
  function setOpen(path, open) {
    if (open) { options.expanded.add(path); options.collapsed.delete(path); }
    else { options.expanded.delete(path); options.collapsed.add(path); }
    build();
  }
  function reveal(path) {
    const existing = indexOf(path);
    if (existing >= 0) return existing;
    let value = options.data;
    let parentPath = '';
    const ancestors = [];
    const keys = path === '' ? [] : path.slice(1).split('/').map(decodeKey);
    for (const key of keys) {
      if (!isContainer(value) || !Object.hasOwn(value, key)) return -1;
      ancestors.push(parentPath);
      value = value[key];
      parentPath = appendJsonPath(parentPath, key);
    }
    for (const ancestor of ancestors) {
      options.expanded.add(ancestor);
      options.collapsed.delete(ancestor);
    }
    build();
    return indexOf(path);
  }

  build();
  return {
    update, setOpen, reveal, rowAt, indexOf,
    sizeOf: (value) => Array.isArray(value) ? value.length : keysOf(value).length,
    get rowCount() { return rowCount; },
  };
}

function prefix(text) {
  let end = Math.min(text.length, PREVIEW_LIMIT);
  const last = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  return text.slice(0, end);
}

function literalPreview(text) {
  return text.length > PREVIEW_LIMIT ? prefix(text) + t('strTruncated', [text.length.toLocaleString()]) : text;
}

function preview(value) {
  if (typeof value === 'string') {
    const encoded = JSON.stringify(prefix(value));
    if (value.length > PREVIEW_LIMIT || encoded.length > PREVIEW_LIMIT) {
      return prefix(encoded) + t('strTruncated', [value.length.toLocaleString()]);
    }
    return encoded;
  }
  return literalPreview(String(value));
}

/**
 * A local-data virtual tree. update replaces any supplied options and rebuilds
 * logical rows; refresh only repaints the viewport. reveal opens ancestors and
 * scrolls to a path. setOpen notifies onToggle only with { notify: true }.
 * Source data must remain immutable between updates, so key lists can be cached.
 */
export function createVirtualTree(container, initial = {}) {
  let options = { rowHeight: 24, overscan: 12, highlights: new Set(), decorations: new Map(), numberLiterals: null, ...initial };
  const model = createTreeModel(options);
  let currentPath = null;
  let activePath = model.rowCount ? '' : null;
  let activeIndex = model.rowCount ? 0 : -1;
  const treeId = `json-tree-${++nextTreeId}`;
  const itemId = (index) => `${treeId}-item-${index}`;
  const originalAttributes = new Map(['role', 'tabindex', 'aria-activedescendant'].map((name) => [name, container.getAttribute(name)]));
  let frame = null;
  let destroyed = false;
  let maxWidth = 0;
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

  function renderRow(descriptor, index) {
    const { value, key, path, depth, kind, open } = descriptor;
    const entry = document.createElement('div');
    entry.className = 'entry';
    entry.dataset.path = path;
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
      row.addEventListener('click', () => {
        activePath = path;
        setOpen(path, false, { notify: true });
        container.focus({ preventScroll: true });
      });
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
    const activate = () => setActive(path, index);
    // Set the active row before the browser focuses the tree on pointer-down.
    row.addEventListener('pointerdown', activate);
    if (key !== null) {
      row.appendChild(span('key', descriptor.isIndex ? String(key) : preview(String(key))));
      row.appendChild(span('punct', ': '));
    }
    if (containerValue) {
      const isArray = Array.isArray(value);
      row.appendChild(span('punct', isArray ? '[' : '{'));
      const size = model.sizeOf(value);
      const summaryText = t(isArray ? 'treeSummaryItems' : 'treeSummaryKeys', [size.toLocaleString()]);
      const summary = span('summary', summaryText);
      entry.setAttribute('aria-label', key === null ? summaryText : `${literalPreview(String(key))}: ${summaryText}`);
      if (size) entry.setAttribute('aria-expanded', String(open));
      if (!open) {
        row.appendChild(summary);
        row.appendChild(span('punct', isArray ? ']' : '}'));
      }
      const flip = () => {
        activate();
        setOpen(path, !open, { notify: true });
        container.focus({ preventScroll: true });
      };
      toggle.addEventListener('click', flip);
      summary.addEventListener('click', flip);
      row.addEventListener('click', (event) => {
        if (event.target === toggle || event.target === summary || hasTextSelection()) return;
        if (event.target === row || event.target.classList.contains('punct')) flip();
        else { activate(); container.focus({ preventScroll: true }); }
      });
    } else {
      const type = value === null ? 'null' : typeof value === 'boolean' ? 'bool' : typeof value;
      const literal = typeof value === 'number' ? options.numberLiterals?.[path] : undefined;
      row.appendChild(span('v ' + type, literal === undefined ? preview(value) : literalPreview(String(literal))));
      row.addEventListener('click', () => {
        if (hasTextSelection()) return;
        activate();
        container.focus({ preventScroll: true });
      });
    }
    return entry;
  }

  function refresh() {
    if (destroyed) return;
    const g = geometry();
    container.style.setProperty?.('--tree-row-height', `${options.rowHeight}px`);
    spacer.style.height = `${g.physicalHeight}px`;
    const scrollTop = Math.min(Math.max(0, container.scrollTop || 0), g.physicalRange);
    if (container.scrollTop !== scrollTop) container.scrollTop = scrollTop;
    const logicalTop = scrollTop * g.scale;
    const start = Math.max(0, Math.floor(logicalTop / options.rowHeight) - options.overscan);
    const end = Math.min(model.rowCount, Math.ceil((logicalTop + g.viewport) / options.rowHeight) + options.overscan);
    layer.style.top = `${scrollTop - logicalTop + start * options.rowHeight}px`;
    const fragment = document.createDocumentFragment();
    // Keep the active descendant mounted when wheel scrolling recycles its row.
    // This costs one extra row, independent of the size or depth of the JSON.
    let pinned = null;
    if (activeIndex >= 0 && (activeIndex < start || activeIndex >= end)) {
      pinned = renderRow(model.rowAt(activeIndex), activeIndex);
      pinned.classList.add('virtual-active-outside');
    }
    if (pinned && activeIndex < start) fragment.appendChild(pinned);
    for (let index = start; index < end; index++) fragment.appendChild(renderRow(model.rowAt(index), index));
    if (pinned && activeIndex >= end) fragment.appendChild(pinned);
    layer.replaceChildren(fragment);
    if (activeIndex >= 0) container.setAttribute('aria-activedescendant', itemId(activeIndex));
    else container.removeAttribute('aria-activedescendant');
    maxWidth = Math.max(maxWidth, layer.scrollWidth || 0);
    if (maxWidth) spacer.style.minWidth = `${maxWidth}px`;
  }

  function schedule() {
    if (frame !== null || destroyed) return;
    frame = requestFrame(() => { frame = null; refresh(); });
  }
  function update(next = {}) {
    if (Object.hasOwn(next, 'data') && next.data !== options.data) {
      container.scrollTop = 0;
      container.scrollLeft = 0;
      maxWidth = 0;
      spacer.style.minWidth = '';
      currentPath = null;
      activePath = null;
    }
    options = { ...options, ...next };
    model.update(next);
    restoreActive();
    refresh();
  }
  function setOpen(path, open, { notify = false } = {}) {
    model.setOpen(path, open);
    restoreActive();
    refresh();
    if (notify) options.onToggle?.(path, open);
  }
  function reveal(path) {
    const index = model.reveal(path);
    if (index < 0) return false;
    activePath = path;
    activeIndex = index;
    const g = geometry();
    const logicalTop = Math.max(0, Math.min(g.logicalRange, index * options.rowHeight - (g.viewport - options.rowHeight) / 2));
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
    activePath = path;
    activeIndex = index;
    // Pointer activation must not replace text nodes: doing so clears the
    // browser's text selection, including double-click selection of a value.
    for (const entry of [...layer.children]) {
      if (entry.classList.contains('virtual-active-outside')) entry.remove();
      else entry.classList.toggle('keyboard-active', entry.id === itemId(index));
    }
    container.setAttribute('aria-activedescendant', itemId(index));
  }
  function restoreActive() {
    // Collapse/filter operations may hide the active item: fall back to its
    // closest visible ancestor without moving focus out of the tree.
    let path = activePath ?? '';
    let index = model.indexOf(path);
    while (index < 0 && path !== '') {
      path = path.slice(0, path.lastIndexOf('/'));
      index = model.indexOf(path);
    }
    activePath = index < 0 ? null : path;
    activeIndex = index;
  }
  function moveActive(index, step) {
    let row = model.rowAt(index);
    while (row?.kind === 'close') { index += step; row = model.rowAt(index); }
    if (!row) return;
    reveal(row.path);
  }
  function keydown(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || activeIndex < 0) return;
    const row = model.rowAt(activeIndex);
    const expandable = isContainer(row.value) && model.sizeOf(row.value) > 0;
    switch (event.key) {
      case 'ArrowDown': moveActive(activeIndex + 1, 1); break;
      case 'ArrowUp': moveActive(activeIndex - 1, -1); break;
      case 'Home': moveActive(0, 1); break;
      case 'End': moveActive(model.rowCount - 1, -1); break;
      case 'ArrowRight':
        if (expandable && !row.open) setOpen(row.path, true, { notify: true });
        else if (expandable) {
          const child = model.rowAt(activeIndex + 1);
          if (child?.kind === 'entry' && child.depth > row.depth) moveActive(activeIndex + 1, 1);
        }
        break;
      case 'ArrowLeft':
        if (expandable && row.open) setOpen(row.path, false, { notify: true });
        else if (row.path !== '') reveal(row.path.slice(0, row.path.lastIndexOf('/')));
        break;
      case 'Enter':
      case ' ':
        if (expandable) setOpen(row.path, !row.open, { notify: true });
        break;
      default: return;
    }
    event.preventDefault();
    ensureActiveVisible();
  }
  function ensureActiveVisible() {
    if (activeIndex < 0) return;
    const g = geometry();
    const top = (container.scrollTop || 0) * g.scale;
    if (activeIndex * options.rowHeight < top || (activeIndex + 1) * options.rowHeight > top + g.viewport) {
      reveal(activePath);
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
    resizeObserver?.disconnect();
    container.removeEventListener('scroll', schedule);
    container.removeEventListener('keydown', keydown);
    container.removeEventListener('focus', focus);
    for (const [name, value] of originalAttributes) {
      if (value === null) container.removeAttribute(name);
      else container.setAttribute(name, value);
    }
    layer.replaceChildren();
    spacer.replaceChildren();
    container.replaceChildren();
    container.classList.remove('virtual-tree');
    model.update({ data: undefined, expanded: new Set(), collapsed: new Set(), forceExpand: new Set(), requiredChildren: new Map() });
    options = {};
    currentPath = null;
    activePath = null;
    activeIndex = -1;
  }
  container.addEventListener('keydown', keydown);
  container.addEventListener('focus', focus);
  container.addEventListener('scroll', schedule, { passive: true });
  const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  resizeObserver?.observe(container);
  refresh();
  return { update, refresh, setOpen, reveal, setCurrent, destroy, get rowCount() { return model.rowCount; } };
}
