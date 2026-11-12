import { appendJsonPath } from './json-path.js';

const MAX_MATCHES = 500;

/*
 * 迭代式 DFS 搜索（避免深嵌套爆栈）。
 * 命中规则：对象的 key 包含子串，或基本类型的值包含子串（均忽略大小写）。
 * 数组下标不参与 key 匹配，避免搜 "0" 命中一切。
 * 返回命中路径、需要强制展开的祖先路径、总命中数和截断标记。
 */
export function searchData(data, query, numberLiterals = null) {
  const q = query.toLowerCase();
  const highlights = [];
  const forceExpand = new Set();
  let matchCount = 0;
  let truncated = false;

  // 只保存当前祖先的遍历游标；宽数组不需要为每个元素分配待访问节点。
  const stack = [];
  let depth = 0;
  let value = data;
  let key = null;
  let isIndex = false;
  // Only look up paths when a literal changes whether its parsed number
  // matches. Ordinary numeric leaves then keep the allocation-free fast path.
  const literalSensitiveValues = new Set();
  for (const path in numberLiterals) {
    const literal = numberLiterals[path];
    const numeric = Number(literal);
    if (literal.toLowerCase().includes(q) !== String(numeric).toLowerCase().includes(q)) {
      literalSensitiveValues.add(numeric);
    }
  }

  function parentPath() {
    let ancestor = depth - 1;
    while (ancestor >= 0 && stack[ancestor].path === undefined) ancestor--;
    let path = ancestor >= 0 ? stack[ancestor].path : '';
    for (let i = ancestor + 1; i < depth; i++) {
      const frame = stack[i];
      path = frame.path = appendJsonPath(path, frame.key);
    }
    return path;
  }

  while (true) {
    const isContainer = value !== null && typeof value === 'object';
    let displayValue = value;
    if (typeof value === 'number' && literalSensitiveValues.has(value)) {
      const path = key === null ? '' : appendJsonPath(parentPath(), key);
      displayValue = numberLiterals[path] ?? value;
    }
    const matched = (key !== null && !isIndex && key.toLowerCase().includes(q))
      || (!isContainer && String(displayValue).toLowerCase().includes(q));
    if (matched) {
      matchCount++;
      if (highlights.length < MAX_MATCHES) {
        // 未命中以及达到展示上限后仅计数，不创建无用的 JSON Pointer。
        let path = '';
        for (let i = 0; i < depth; i++) {
          const frame = stack[i];
          if (frame.path === undefined) frame.path = appendJsonPath(path, frame.key);
          path = frame.path;
          forceExpand.add(path);
        }
        highlights.push(key === null ? '' : appendJsonPath(path, key));
      } else {
        truncated = true;
      }
    }

    if (isContainer) {
      const keys = Array.isArray(value) ? null : Object.keys(value);
      const length = keys === null ? value.length : keys.length;
      if (length) {
        // 同一深度复用游标，遍历大量小对象时避免逐对象分配帧。
        let frame = stack[depth];
        if (!frame) frame = stack[depth] = {};
        frame.value = value;
        frame.keys = keys;
        frame.length = length;
        frame.index = 0;
        frame.key = key;
        frame.path = key === null ? '' : undefined;
        depth++;
      }
    }

    while (depth && stack[depth - 1].index === stack[depth - 1].length) {
      const frame = stack[--depth];
      frame.value = null;
      frame.keys = null;
      frame.path = undefined;
    }
    if (!depth) break;
    const frame = stack[depth - 1];
    isIndex = frame.keys === null;
    key = isIndex ? frame.index : frame.keys[frame.index];
    value = frame.value[key];
    frame.index++;
  }

  return { highlights, forceExpand: [...forceExpand], matchCount, truncated };
}
