import { createTreeModel } from '../core/tree-model.js';

const MAX_ROWS = 256;
const PREVIEW_LIMIT = 2000;
function prefix(text) {
  let end = Math.min(text.length, PREVIEW_LIMIT);
  if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff
    && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
  return text.slice(0, end);
}

// Models and the parsed document stay in the Worker. A window never contains
// a nested value, even for deep JSON that structured clone cannot serialize.
export function createTreeTasks() {
  const snapshots = new WeakMap();
  return function treeTask(snapshot, document, request) {
    let models = snapshots.get(snapshot);
    if (!models) snapshots.set(snapshot, models = new Map());
    const side = request.side || 'document';
    let model = models.get(side);
    if (!model) {
      model = createTreeModel({ ...request.options, data: document.data });
      models.set(side, model);
    } else if (request.operation === 'update') {
      model.update(request.options || {});
    }
    const count = Math.max(1, Math.min(MAX_ROWS, Math.floor(request.count) || MAX_ROWS));
    let activePath = request.activePath ?? '';
    let revealIndex;
    if (request.operation === 'setOpen') model.setOpen(request.path, request.open);
    if (request.operation === 'reveal') {
      revealIndex = model.reveal(request.path);
      if (revealIndex >= 0) activePath = request.path;
    }
    if (request.operation === 'move') {
      let index = Math.floor(request.index);
      const step = request.step < 0 ? -1 : 1;
      let row = model.rowAt(index);
      while (row?.kind === 'close') row = model.rowAt(index += step);
      if (row) { activePath = row.path; revealIndex = index; }
    }
    let activeIndex = model.indexOf(activePath);
    while (activeIndex < 0 && activePath !== '') {
      activePath = activePath.slice(0, activePath.lastIndexOf('/'));
      activeIndex = model.indexOf(activePath);
    }
    function descriptor(index) {
      const row = model.rowAt(index);
      if (!row) return null;
      const { value, key, ...rest } = row;
      const result = { ...rest, key };
      if (typeof key === 'string') {
        result.key = prefix(key);
        result.keyLength = key.length;
      }
      if (value !== null && typeof value === 'object') {
        result.value = Array.isArray(value) ? [] : {};
        result.size = model.sizeOf(value);
      } else if (typeof value === 'string') {
        result.value = prefix(value);
        result.valueLength = value.length;
      } else {
        result.value = value;
        if (typeof value === 'number' && document.numberLiterals?.[row.path] !== undefined) {
          const literal = document.numberLiterals[row.path];
          result.literal = prefix(literal);
          result.literalLength = literal.length;
        }
      }
      return result;
    }
    const requestedStart = revealIndex >= 0 ? Math.max(0, revealIndex - Math.floor(count / 2)) : Math.floor(request.start) || 0;
    const start = Math.min(Math.max(0, requestedStart), Math.max(0, model.rowCount - count));
    const rows = [];
    for (let index = start; index < Math.min(model.rowCount, start + count); index++) rows.push(descriptor(index));
    return {
      rowCount: model.rowCount, start, rows, activeIndex,
      activePath: activeIndex < 0 ? null : activePath,
      activeRow: activeIndex < 0 ? null : descriptor(activeIndex),
      ...(revealIndex === undefined ? {} : { revealIndex }),
    };
  };
}
