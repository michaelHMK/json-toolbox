import { appendJsonPath, createChildPathIndex } from './json-path.js';

const isContainer = (value) => value !== null && typeof value === 'object';
const decodeKey = (key) => key.replace(/~1/g, '/').replace(/~0/g, '~');
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

  let expansionChildren = new Map();

  function rememberExpansion(path) {
    while (path !== '') {
      const parent = path.slice(0, path.lastIndexOf('/'));
      let children = expansionChildren.get(parent);
      if (!children) expansionChildren.set(parent, children = new Set());
      if (children.has(path)) break;
      children.add(path);
      path = parent;
    }
  }

  function forgetExpansion(path) {
    while (path !== '' && !options.expanded.has(path) && !options.forceExpand.has(path)
      && !expansionChildren.get(path)?.size) {
      const parent = path.slice(0, path.lastIndexOf('/'));
      const siblings = expansionChildren.get(parent);
      if (!siblings) break;
      siblings.delete(path);
      if (!siblings.size) expansionChildren.delete(parent);
      path = parent;
    }
  }

  // Build only the requested subtree. Existing siblings retain their records,
  // key caches and descriptors when a user opens or closes one container.
  function subtree(rootDescriptor, startRow = 0) {
    const output = [];
    let nextRow = startRow;
    function emit(segment, count = 1) {
      segment.row = nextRow;
      segment.count = count;
      segment.index = output.length;
      nextRow += count;
      output.push(segment);
      return segment;
    }
    function enter(descriptor) {
      const { value, path, depth } = descriptor;
      const open = isContainer(value) && openAt(path, depth);
      const entry = emit({ kind: 'entry', descriptor: { ...descriptor, open } });
      if (!open) return null;
      const record = { value, path, depth, keys: keysOf(value), indices: null, ranges: [], entry, close: null };
      if (options.onlyRequired) record.indices = positionsFor(record, options.requiredChildren.get(path));
      record.length = record.indices ? record.indices.length : record.keys ? record.keys.length : value.length;
      record.opens = [];
      if (depth + 1 < options.expandLevel) {
        // Primitive siblings share one range, even when all containers open.
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

    const root = enter(rootDescriptor);
    const stack = root ? [root] : [];
    while (stack.length) {
      const record = stack[stack.length - 1];
      const child = record.opens[record.openIndex];
      const end = child ? child.position : record.length;
      if (end > record.next) record.ranges.push(emit({ kind: 'range', record, start: record.next }, end - record.next));
      if (child) {
        record.next = child.position + 1;
        record.openIndex++;
        const nested = enter({ kind: 'entry', value: child.value, key: child.key, path: child.path,
          depth: record.depth + 1, isIndex: record.keys === null, posInSet: child.position + 1, setSize: record.length });
        if (nested) stack.push(nested);
      } else {
        record.close = emit({ kind: 'close', descriptor: { kind: 'close', value: record.value, path: record.path, depth: record.depth } });
        record.opens = null;
        stack.pop();
      }
    }
    return output;
  }

  function build() {
    segments = [];
    containers = new Map();
    rowCount = 0;
    expansionChildren = createChildPathIndex([...options.expanded, ...options.forceExpand]);
    if (options.data === undefined) return;
    segments = subtree({ kind: 'entry', value: options.data, key: null, path: '', depth: 0, isIndex: false, posInSet: 1, setSize: 1 });
    const last = segments[segments.length - 1];
    rowCount = last.row + last.count;
  }

  function segmentAt(index) {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (segments[mid].row + segments[mid].count <= index) lo = mid + 1;
      else hi = mid;
    }
    return segments[lo];
  }

  // Array.splice(...subtree) exceeds the argument limit for large subtrees.
  // Shift in place instead; no unaffected descriptor or record is allocated.
  function replaceSegments(start, count, replacement) {
    const firstRow = segments[start].row;
    const end = start + count;
    const oldRows = (segments[end]?.row ?? rowCount) - firstRow;
    let addedRows = 0;
    for (const segment of replacement) addedRows += segment.count;
    const rowDelta = addedRows - oldRows;
    const delta = replacement.length - count;
    const oldLength = segments.length;
    if (delta > 0) {
      segments.length = oldLength + delta;
      for (let i = oldLength - 1; i >= end; i--) {
        const segment = segments[i];
        segment.index = i + delta;
        segment.row += rowDelta;
        segments[i + delta] = segment;
      }
    } else {
      for (let i = end; i < oldLength; i++) {
        const segment = segments[i];
        segment.index = i + delta;
        segment.row += rowDelta;
        segments[i + delta] = segment;
      }
      segments.length = oldLength + delta;
    }
    let row = firstRow;
    for (let i = 0; i < replacement.length; i++) {
      const segment = replacement[i];
      segment.index = start + i;
      segment.row = row;
      row += segment.count;
      segments[start + i] = segment;
    }
    rowCount += rowDelta;
  }

  function rangePosition(record, position) {
    let lo = 0;
    let hi = record.ranges.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (record.ranges[mid].start < position) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function rowAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= rowCount) return null;
    const segment = segmentAt(index);
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
    if (opened) return opened.entry.row;
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
    const changes = modelOptions(next);
    if (!Object.keys(changes).length) return;
    if (Object.hasOwn(changes, 'data') && changes.data !== options.data) keyCache = new WeakMap();
    options = { ...options, ...changes };
    build();
  }
  function setOpen(path, open) {
    if (open) {
      options.expanded.add(path);
      options.collapsed.delete(path);
      rememberExpansion(path);
    } else {
      options.expanded.delete(path);
      forgetExpansion(path);
      options.collapsed.add(path);
    }
    const record = containers.get(path);
    if (open === !!record) return;
    if (!open) {
      const start = record.entry.index;
      const count = record.close.index - start + 1;
      let replacement;
      if (path === '') {
        replacement = { kind: 'entry', descriptor: { ...record.entry.descriptor, open: false }, count: 1 };
      } else {
        const parent = containers.get(path.slice(0, path.lastIndexOf('/')));
        const position = record.entry.descriptor.posInSet - 1;
        replacement = { kind: 'range', record: parent, start: position, count: 1 };
        parent.ranges.splice(rangePosition(parent, position), 0, replacement);
      }
      for (let i = start; i < start + count; i++) {
        const segment = segments[i];
        if (segment.kind === 'entry') containers.delete(segment.descriptor.path);
      }
      replaceSegments(start, count, [replacement]);
      return;
    }
    const index = indexOf(path);
    if (index < 0) return; // A hidden child keeps its override until its parent opens.
    const descriptor = rowAt(index);
    if (!isContainer(descriptor.value)) return;
    const segment = segmentAt(index);
    const replacement = subtree(descriptor, index);
    if (segment.kind === 'range') {
      const position = segment.start + index - segment.row;
      const ranges = [];
      if (position > segment.start) {
        const before = { kind: 'range', record: segment.record, start: segment.start, count: position - segment.start };
        ranges.push(before);
        replacement.unshift(before);
      }
      const remaining = segment.start + segment.count - position - 1;
      if (remaining) {
        const after = { kind: 'range', record: segment.record, start: position + 1, count: remaining };
        ranges.push(after);
        replacement.push(after);
      }
      segment.record.ranges.splice(rangePosition(segment.record, segment.start), 1, ...ranges);
    }
    replaceSegments(segment.index, 1, replacement);
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
    for (const ancestor of ancestors) if (!containers.has(ancestor)) setOpen(ancestor, true);
    return indexOf(path);
  }

  build();
  return {
    update, setOpen, reveal, rowAt, indexOf,
    sizeOf: (value) => Array.isArray(value) ? value.length : keysOf(value).length,
    get rowCount() { return rowCount; },
  };
}
