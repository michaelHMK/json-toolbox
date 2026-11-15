// JSON Pointer：根路径为空字符串，key 中的 ~ 和 / 必须转义。
export const PATH_SEP = '/';

export function appendJsonPath(path, key) {
  key = String(key);
  if (key.includes('~') || key.includes('/')) {
    key = key.replace(/~/g, '~0').replace(/\//g, '~1');
  }
  return path + PATH_SEP + key;
}

// 只为命中路径建立祖先索引，宽容器无需为找到一个远端命中渲染全部兄弟。
export function createChildPathIndex(paths) {
  const index = new Map();
  for (let path of paths) {
    while (path !== '') {
      const parent = path.slice(0, path.lastIndexOf('/'));
      let children = index.get(parent);
      if (!children) index.set(parent, children = new Set());
      if (children.has(path)) break;
      children.add(path);
      path = parent;
    }
  }
  return index;
}
