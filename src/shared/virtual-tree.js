import { createTreeModel } from '../core/tree-model.js';
export { createTreeModel } from '../core/tree-model.js';
import { span } from './json-tree.js';
import { t } from './i18n.js';

const isContainer = (value) => value !== null && typeof value === 'object';
const PREVIEW_LIMIT = 2000;
const MAX_SCROLL_HEIGHT = 8_000_000;
let nextTreeId = 0;

function prefix(text) {
  let end = Math.min(text.length, PREVIEW_LIMIT);
  const last = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  return text.slice(0, end);
}

function literalPreview(text, length = text.length) {
  return length > PREVIEW_LIMIT ? prefix(text) + t('strTruncated', [length.toLocaleString()]) : text;
}

function preview(value, length = typeof value === 'string' ? value.length : undefined) {
  if (typeof value === 'string') {
    const encoded = JSON.stringify(prefix(value));
    if (length > PREVIEW_LIMIT || encoded.length > PREVIEW_LIMIT) {
      return prefix(encoded) + t('strTruncated', [length.toLocaleString()]);
    }
    return encoded;
  }
  return literalPreview(String(value));
}

/**
 * A virtual tree with either a local model or an injected windowed model.
 * update replaces supplied options; refresh only paints the viewport. reveal
 * opens ancestors and scrolls to a path. setOpen notifies onToggle only with
 * { notify: true }. Local operations stay synchronous; remote mutations return
 * promises and window misses render placeholders until their response arrives.
 * Source data must remain immutable between updates, so key lists can be cached.
 */
export function createVirtualTree(container, initial = {}) {
  let options = { rowHeight: 24, overscan: 12, highlights: new Set(), decorations: new Map(), numberLiterals: null, ...initial };
  const model = initial.model || createTreeModel(options);
  let currentPath = null;
  let activationVersion = 0;
  let activePath = model.rowCount ? '' : null;
  let activeIndex = model.rowCount ? 0 : -1;
  const treeId = `json-tree-${++nextTreeId}`;
  const itemId = (index) => `${treeId}-item-${index}`;
  const originalAttributes = new Map(['role', 'tabindex', 'aria-activedescendant'].map((name) => [name, container.getAttribute(name)]));
  let frame = null;
  let destroyed = false;
  let navigation = Promise.resolve();
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
        activationVersion++;
        activePath = path;
        model.setActive?.(path, -1);
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
      row.appendChild(span('key', descriptor.isIndex ? String(key) : preview(String(key), descriptor.keyLength)));
      row.appendChild(span('punct', ': '));
    }
    if (containerValue) {
      const isArray = Array.isArray(value);
      row.appendChild(span('punct', isArray ? '[' : '{'));
      const size = descriptor.size ?? model.sizeOf(value);
      const summaryText = t(isArray ? 'treeSummaryItems' : 'treeSummaryKeys', [size.toLocaleString()]);
      const summary = span('summary', summaryText);
      entry.setAttribute('aria-label', key === null ? summaryText : `${literalPreview(String(key), descriptor.keyLength)}: ${summaryText}`);
      if (size) entry.setAttribute('aria-expanded', String(open));
      if (!open) {
        row.appendChild(summary);
        row.appendChild(span('punct', isArray ? ']' : '}'));
      }
      const flip = () => {
        activate();
        setOpen(path, !(model.openState?.(path, open) ?? open), { notify: true });
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
      const literal = descriptor.literal ?? (typeof value === 'number' ? options.numberLiterals?.[path] : undefined);
      row.appendChild(span('v ' + type, literal === undefined ? preview(value, descriptor.valueLength)
        : literalPreview(String(literal), descriptor.literalLength)));
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
    const loading = model.ensureRange?.(start, end);
    if (loading) loading.then((changed) => {
      if (changed && !destroyed) { restoreActive(); refresh(); }
    });
    layer.style.top = `${scrollTop - logicalTop + start * options.rowHeight}px`;
    const fragment = document.createDocumentFragment();
    // Keep the active descendant mounted when wheel scrolling recycles its row.
    // This costs one extra row, independent of the size or depth of the JSON.
    let pinned = null;
    if (activeIndex >= 0 && (activeIndex < start || activeIndex >= end)) {
      const descriptor = model.rowAt(activeIndex);
      if (descriptor) {
        pinned = renderRow(descriptor, activeIndex);
        pinned.classList.add('virtual-active-outside');
      }
    }
    if (pinned && activeIndex < start) fragment.appendChild(pinned);
    for (let index = start; index < end; index++) {
      const descriptor = model.rowAt(index);
      if (descriptor) fragment.appendChild(renderRow(descriptor, index));
      else {
        const placeholder = document.createElement('div');
        placeholder.className = 'entry virtual-placeholder';
        placeholder.setAttribute('aria-hidden', 'true');
        fragment.appendChild(placeholder);
      }
    }
    if (pinned && activeIndex >= end) fragment.appendChild(pinned);
    layer.replaceChildren(fragment);
    if (activeIndex >= 0 && model.rowAt(activeIndex)) container.setAttribute('aria-activedescendant', itemId(activeIndex));
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
    return after(model.update(next), () => { restoreActive(); refresh(); });
  }
  // The local model is synchronous. Remote models keep the same rendering and
  // interaction code, but settle mutations only after their Worker response.
  function after(result, apply) {
    if (result?.then) return result.then((value) => {
      if (!destroyed && value !== false) return apply(value);
      return false;
    });
    return apply(result);
  }
  function setOpen(path, open, { notify = false } = {}) {
    const result = model.setOpen(path, open);
    // Synchronize paired trees for every user intention, including quick
    // successive clicks whose older rendering response is superseded.
    if (notify && result?.then) options.onToggle?.(path, open);
    return after(result, () => {
      restoreActive();
      refresh();
      if (model.move) ensureActiveVisible();
      if (notify && !result?.then) options.onToggle?.(path, open);
    });
  }
  function reveal(path) {
    return navigateResult(model.reveal(path), (index) => showPath(path, index));
  }
  function navigateResult(result, apply) {
    const selected = activationVersion;
    return after(result, (value) => {
      if (model.active && selected !== activationVersion) {
        restoreActive();
        refresh();
        ensureActiveVisible();
        return true;
      }
      return apply(value);
    });
  }
  function showPath(path, index) {
    if (index < 0) return false;
    activePath = path;
    activeIndex = index;
    model.setActive?.(path, index);
    const g = geometry();
    const logicalTop = Math.max(0, Math.min(g.logicalRange, index * options.rowHeight - (g.viewport - options.rowHeight) / 2));
    // A reveal can be the first response of an asynchronous tree (superseding
    // its initial update). Grow the physical scroller before assigning its
    // position, otherwise browsers clamp that assignment to the old height.
    spacer.style.height = `${g.physicalHeight}px`;
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
    model.setActive?.(path, index);
    // Pointer activation must not replace text nodes: doing so clears the
    // browser's text selection, including double-click selection of a value.
    for (const entry of [...layer.children]) {
      if (entry.classList.contains('virtual-active-outside')) entry.remove();
      else entry.classList.toggle('keyboard-active', entry.id === itemId(index));
    }
    container.setAttribute('aria-activedescendant', itemId(index));
  }
  function restoreActive() {
    if (model.active) {
      activePath = model.active.path;
      activeIndex = model.active.index;
      return;
    }
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
    if (model.move) return navigateResult(model.move(index, step), (next) => {
      if (next >= 0) return showPath(model.active.path, next);
    });
    let row = model.rowAt(index);
    while (row?.kind === 'close') { index += step; row = model.rowAt(index); }
    if (!row) return;
    reveal(row.path);
  }
  function navigate(key) {
    if (destroyed || activeIndex < 0) return;
    const row = model.rowAt(activeIndex);
    if (!row) return;
    const expandable = isContainer(row.value) && (row.size ?? model.sizeOf(row.value)) > 0;
    switch (key) {
      case 'ArrowDown': return moveActive(activeIndex + 1, 1);
      case 'ArrowUp': return moveActive(activeIndex - 1, -1);
      case 'Home': return moveActive(0, 1);
      case 'End': return moveActive(model.rowCount - 1, -1);
      case 'ArrowRight':
        if (expandable && !row.open) return setOpen(row.path, true, { notify: true });
        else if (expandable) {
          if (model.child) return navigateResult(model.child(row.path), (index) => {
            if (index >= 0) return showPath(model.active.path, index);
          });
          const child = model.rowAt(activeIndex + 1);
          if (child?.kind === 'entry' && child.depth > row.depth) return moveActive(activeIndex + 1, 1);
        }
        break;
      case 'ArrowLeft':
        if (expandable && row.open) return setOpen(row.path, false, { notify: true });
        else if (row.path !== '') return reveal(row.path.slice(0, row.path.lastIndexOf('/')));
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
    if (model.move) {
      const selected = activationVersion;
      navigation = navigation.then(async () => {
        if (selected !== activationVersion || destroyed) return;
        await model.whenSettled?.();
        if (selected === activationVersion && !destroyed) {
          restoreActive();
          return navigate(event.key);
        }
      });
    }
    else { navigate(event.key); ensureActiveVisible(); }
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
    if (model.destroy) model.destroy();
    else model.update({ data: undefined, expanded: new Set(), collapsed: new Set(), forceExpand: new Set(), requiredChildren: new Map() });
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
