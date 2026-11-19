import { appendJsonPath } from './json-path.js';
import { previewPrefix } from './preview.js';

// 超出明细上限仍继续统计总数；主键配对映射单独限制大小。
const MAX_DIFFS = 5000;
const MAX_PAIRS = 100000;
const WILD_ONE = Symbol('*');
const WILD_ANY = Symbol('**');
const SUBTREE_IGNORED = Symbol('subtree-ignored');

// Compare decimal values without converting through IEEE-754. This preserves
// equivalence of 1.00 and 1e0, while distinguishing rounded/overflowed numbers.
function canonicalNumber(literal) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(literal);
  if (!match) return literal;
  const fraction = match[3] || '';
  const digits = (match[2] + fraction).replace(/^0+/, '');
  if (!digits) return '0';
  const coefficient = digits.replace(/0+$/, '');
  const exponent = BigInt(match[4] || '0') - BigInt(fraction.length) + BigInt(digits.length - coefficient.length);
  return match[1] + coefficient + 'e' + exponent;
}

// Only precision-changing literals affect equality. Keep those values in a
// sparse path trie so traversal can carry a child index without rebuilding or
// hashing a complete JSON Pointer for every equal numeric leaf.
function indexNumberValues(literals) {
  let root;
  for (const path in literals) {
    const literal = literals[path];
    const exact = canonicalNumber(literal);
    if (exact === canonicalNumber(String(Number(literal)))) continue;
    if (path === '') {
      root = exact;
      continue;
    }
    const segments = path.slice(1).split('/');
    let node = root ?? (root = new Map());
    for (let i = 0; i < segments.length; i++) {
      const key = segments[i].replace(/~1/g, '/').replace(/~0/g, '~');
      if (i === segments.length - 1) {
        node.set(key, exact);
      } else {
        let child = node.get(key);
        if (!child) node.set(key, child = new Map());
        node = child;
      }
    }
  }
  return root;
}

function readQuotedKey(pattern, start) {
  const quote = pattern[start];
  let i = start + 1;
  let out = '';
  while (i < pattern.length) {
    const ch = pattern[i++];
    if (ch === quote) return { value: out, next: i };
    if (ch === '\\' && i < pattern.length) {
      const esc = pattern[i++];
      if (esc === 'u' && /^[0-9a-fA-F]{4}$/.test(pattern.slice(i, i + 4))) {
        out += String.fromCharCode(parseInt(pattern.slice(i, i + 4), 16));
        i += 4;
      } else {
        out += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[esc] ?? esc;
      }
    } else {
      out += ch;
    }
  }
  return null;
}

// 解析忽略路径模式：
// 'a.b[0].c' → ['a','b','0','c']；'list[*].x' → ['list',WILD_ONE,'x']；
// 'metadata.**' → ['metadata',WILD_ANY]；'a["x.y"][""]' → ['a','x.y','']
function parseIgnorePattern(pattern) {
  if (typeof pattern !== 'string') return [];
  const trimmed = pattern.trim();
  if (!trimmed) return [];
  const segs = [];
  const push = (token) => {
    if (token === WILD_ANY && segs[segs.length - 1] === WILD_ANY) return;
    segs.push(token);
  };
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (ch === '.' || ch === ']') {
      i++;
      continue;
    }
    if (ch === '[') {
      i++;
      while (i < trimmed.length && trimmed[i] === ' ') i++;
      if (trimmed[i] === '"' || trimmed[i] === "'") {
        const quoted = readQuotedKey(trimmed, i);
        if (!quoted) return [];
        i = quoted.next;
        while (i < trimmed.length && trimmed[i] === ' ') i++;
        if (trimmed[i] !== ']') return [];
        i++;
        push(quoted.value);
      } else {
        const close = trimmed.indexOf(']', i);
        if (close === -1) return [];
        const inner = trimmed.slice(i, close).trim();
        i = close + 1;
        if (!inner) continue;
        if (inner === '*') push(WILD_ONE);
        else if (inner === '**') push(WILD_ANY);
        else push(inner);
      }
      continue;
    }
    const start = i;
    while (i < trimmed.length && trimmed[i] !== '.' && trimmed[i] !== '[' && trimmed[i] !== ']') i++;
    const raw = trimmed.slice(start, i);
    if (raw === '*') push(WILD_ONE);
    else if (raw === '**') push(WILD_ANY);
    else push(raw);
  }
  return segs;
}

function createIgnoreNode(isWildAny = false) {
  return {
    exact: false,
    subtree: false,
    isWildAny,
    children: null,
    wildOne: null,
    wildAny: null,
    mark: 0,
  };
}

// 将忽略路径编译为增量 Trie 状态机：
// 精确路径和单段 * 在叶节点拦截；末尾 ** 标记 subtree，进入容器前整棵剪枝；
// 中段/前导 ** 通过去重后的活动状态集线性推进，避免深层回溯或重复扫描路径段。
function createIgnoreMatcher(rawPatterns) {
  const parsed = (rawPatterns || []).map(parseIgnorePattern).filter((s) => s.length > 0);
  if (!parsed.length) return null;
  const root = createIgnoreNode();
  for (const tokens of parsed) {
    let node = root;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === WILD_ANY) {
        if (i === tokens.length - 1) {
          node.subtree = true;
        } else {
          node = node.wildAny || (node.wildAny = createIgnoreNode(true));
        }
      } else if (token === WILD_ONE) {
        node = node.wildOne || (node.wildOne = createIgnoreNode());
      } else {
        if (!node.children) node.children = new Map();
        let child = node.children.get(token);
        if (!child) node.children.set(token, child = createIgnoreNode());
        node = child;
      }
    }
    if (tokens[tokens.length - 1] !== WILD_ANY) node.exact = true;
  }

  let stamp = 0;

  function addReachable(node, out) {
    if (node.subtree) return true;
    if ((node.isWildAny || node.exact || node.children || node.wildOne) && node.mark !== stamp) {
      node.mark = stamp;
      out.push(node);
    }
    if (node.wildAny) {
      if (node.wildAny.subtree) return true;
      if (node.wildAny.mark !== stamp) {
        node.wildAny.mark = stamp;
        out.push(node.wildAny);
      }
    }
    return false;
  }

  function advanceNode(node, segment, keyRef, out) {
    if (node.isWildAny && addReachable(node, out)) return true;
    if (node.children) {
      const key = keyRef.key ?? (keyRef.key = typeof segment === 'string' ? segment : String(segment));
      const child = node.children.get(key);
      if (child && addReachable(child, out)) return true;
    }
    if (node.wildOne && addReachable(node.wildOne, out)) return true;
    return false;
  }

  let initialState;
  if (root.subtree) {
    initialState = SUBTREE_IGNORED;
  } else if (root.wildAny) {
    initialState = root.children || root.wildOne || root.exact ? [root, root.wildAny] : root.wildAny;
  } else {
    initialState = root;
  }

  function step(state, segment) {
    if (state === null || state === SUBTREE_IGNORED) return state;
    if (!Array.isArray(state)) {
      if (!state.isWildAny) {
        const child = state.children
          ? state.children.get(typeof segment === 'string' ? segment : String(segment))
          : undefined;
        const wild = state.wildOne;
        if (!child && !wild) return null;
        if (child && !wild) {
          if (child.subtree) return SUBTREE_IGNORED;
          if (!child.wildAny) return child;
        } else if (wild && !child) {
          if (wild.subtree) return SUBTREE_IGNORED;
          if (!wild.wildAny) return wild;
        }
      }
      stamp++;
      const out = [];
      if (advanceNode(state, segment, { key: null }, out)) return SUBTREE_IGNORED;
      return out.length === 0 ? null : out.length === 1 ? out[0] : out;
    }
    stamp++;
    const out = [];
    const keyRef = { key: null };
    for (let i = 0; i < state.length; i++) {
      if (advanceNode(state[i], segment, keyRef, out)) return SUBTREE_IGNORED;
    }
    return out.length === 0 ? null : out.length === 1 ? out[0] : out;
  }

  function isIgnored(state) {
    if (state === null) return false;
    if (state === SUBTREE_IGNORED) return true;
    if (!Array.isArray(state)) return state.exact;
    for (let i = 0; i < state.length; i++) {
      if (state[i].exact) return true;
    }
    return false;
  }

  return { initialState, step, isIgnored };
}

// 段数组 → 展示用路径，如 a.b[0].c / a["weird key"]
function displayPath(segs) {
  if (!segs.length) return '(根)';
  let out = '';
  for (const raw of segs) {
    const s = String(raw);
    if (/^\d+$/.test(s)) out += '[' + s + ']';
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s)) out += (out ? '.' : '') + s;
    else out += '[' + JSON.stringify(s) + ']';
  }
  return out;
}

function previewValue(v, path, numberLiterals) {
  if (v === undefined) return '';
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'string') {
      const encoded = JSON.stringify(previewPrefix(v, 81));
      return v.length > 80 || encoded.length > 80 ? previewPrefix(encoded, 80) + '…' : encoded;
    }
    let s;
    if (typeof v === 'number' && numberLiterals && path != null && Object.prototype.hasOwnProperty.call(numberLiterals, path)) {
      s = numberLiterals[path];
    } else {
      s = JSON.stringify(v);
    }
    return s.length > 80 ? previewPrefix(s, 80) + '…' : s;
  }
  if (Array.isArray(v)) return '[' + v.length + ' 项]';
  return '{' + Object.keys(v).length + ' 键}';
}

function jsonType(value) {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

/*
 * 结构 diff：深度优先对齐两棵树，产出 added / removed / changed / typeChanged 四类差异。
 * 数组默认按下标对齐；指定 keyField 且两边元素都是含该字段的对象时按主键配对，
 * 元素换位不算差异；不满足条件则回退下标模式并置 keyFallback。
 * 忽略路径默认精确段匹配（* 匹配任意单段，** 匹配零或多段/整棵子树并提前剪枝，
 * ["key"] / ['key'] 支持含特殊字符的对象键名）。
 */
export function diffData(left, right, options) {
  const keyField = (options && options.keyField) || '';
  const includePreviews = options?.includePreviews !== false;
  const leftNumberLiterals = (options && options.leftNumberLiterals) || null;
  const rightNumberLiterals = (options && options.rightNumberLiterals) || null;
  const sameDocument = left === right && leftNumberLiterals === rightNumberLiterals && !keyField;
  const leftNumbers = sameDocument ? undefined : indexNumberValues(leftNumberLiterals);
  const rightNumbers = sameDocument || leftNumberLiterals === rightNumberLiterals
    ? leftNumbers : indexNumberValues(rightNumberLiterals);
  const ignoreMatcher = createIgnoreMatcher(options && options.ignorePaths);
  const diffs = [];
  const pairs = [];
  const unpaired = { left: new Map(), right: new Map() };
  let mappingCount = 0;
  const stats = { added: 0, removed: 0, changed: 0, typeChanged: 0 };
  let truncated = false;
  let pairsTruncated = false;
  let keyFallback = false;

  // 与树渲染共用 JSON Pointer 路径，任意 key 都能无损编码
  function toPath(segs) {
    let path = '';
    for (const seg of segs) path = appendJsonPath(path, seg);
    return path;
  }

  function omitMapping(array) {
    pairsTruncated = true;
    options?.onTruncatedArray?.(array);
  }

  // Single-sided rows arrive in increasing order on each side of an array.
  // Keep one parent pointer and inclusive index ranges, independent of which
  // differences were ignored or included in the displayed detail list.
  function recordUnpaired(frame, side, index, segments) {
    const field = side === 'left' ? 'removedRanges' : 'addedRanges';
    let ranges = frame[field];
    if (ranges && ranges.at(-1) === index - 1) {
      ranges[ranges.length - 1] = index;
    } else if (mappingCount < MAX_PAIRS) {
      if (!ranges) {
        ranges = frame[field] = [];
        unpaired[side].set(toPath(segments.slice(0, -1)), ranges);
      }
      ranges.push(index, index);
      mappingCount++;
    } else {
      omitMapping(frame[side]);
    }
  }

  function record(type, leftSegs, rightSegs, lv, rv) {
    stats[type]++;
    if (diffs.length < MAX_DIFFS) {
      const leftPath = leftSegs ? toPath(leftSegs) : null;
      const rightPath = rightSegs ? toPath(rightSegs) : null;
      if (includePreviews) {
        diffs.push({
          type,
          leftPath,
          rightPath,
          display: displayPath(rightSegs || leftSegs),
          leftPreview: previewValue(lv, leftPath, leftNumberLiterals),
          rightPreview: previewValue(rv, rightPath, rightNumberLiterals),
        });
      } else {
        diffs.push({ type, leftPath, rightPath });
      }
    } else {
      truncated = true;
    }
  }

  // A primary key must be present, scalar, typed and unique on each side.
  function keyedIndex(arr, numbers) {
    if (!keyField) return null;
    const index = new Map();
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      if (item === null || typeof item !== 'object' || Array.isArray(item)
        || !Object.prototype.hasOwnProperty.call(item, keyField)) return null;
      const value = item[keyField];
      const type = typeof value;
      if (value === null || (type !== 'string' && type !== 'number' && type !== 'boolean')) return null;
      let token = String(value);
      if (type === 'number') {
        token = numbers?.get(String(i))?.get(keyField) ?? canonicalNumber(token);
      }
      const key = type + ':' + token;
      if (index.has(key)) return null;
      index.set(key, i);
    }
    return index;
  }

  function numbersDiffer(lv, rv, leftLiteral, rightLiteral) {
    if (leftLiteral === rightLiteral) return false;
    return (leftLiteral ?? canonicalNumber(String(lv))) !== (rightLiteral ?? canonicalNumber(String(rv)));
  }

  // 活动帧按深度复用，不依赖调用栈，也不为每个待访问节点分配任务对象。
  // type: 1=对象，2=按下标对齐的数组，3=按主键配对的数组。
  const frames = [];
  const leftSegs = [];
  const rightSegs = [];

  function enter(lv, rv, depth, leftNumbers, rightNumbers, leftIgnore, rightIgnore) {
    if (leftIgnore === SUBTREE_IGNORED || rightIgnore === SUBTREE_IGNORED) return false;
    if (lv === rv && !keyField && leftNumbers === rightNumbers) return false;
    const type = jsonType(lv);
    if (type !== jsonType(rv)) {
      if ((!leftIgnore || !ignoreMatcher.isIgnored(leftIgnore))
          && (!rightIgnore || !ignoreMatcher.isIgnored(rightIgnore))) {
        record('typeChanged', leftSegs, rightSegs, lv, rv);
      }
      return false;
    }
    if (type !== 'object' && type !== 'array') {
      if ((lv !== rv || (type === 'number' && numbersDiffer(lv, rv, leftNumbers, rightNumbers)))
          && (!leftIgnore || !ignoreMatcher.isIgnored(leftIgnore))
          && (!rightIgnore || !ignoreMatcher.isIgnored(rightIgnore))) {
        record('changed', leftSegs, rightSegs, lv, rv);
      }
      return false;
    }
    let frame = frames[depth];
    if (!frame) {
      frame = {
        left: null, right: null, leftNumbers: null, rightNumbers: null,
        leftIgnore: null, rightIgnore: null,
        type: 0, index: 0, length: 0, keys: null, rightByKey: null, leftKeys: null, matched: null,
      };
      frames[depth] = frame;
    }
    frame.left = lv;
    frame.right = rv;
    frame.leftNumbers = leftNumbers;
    frame.rightNumbers = rightNumbers;
    frame.leftIgnore = leftIgnore;
    frame.rightIgnore = rightIgnore;
    frame.index = 0;
    if (type === 'object') {
      frame.type = 1;
      frame.keys = Object.keys(lv);
    } else {
      const leftByKey = keyedIndex(lv, leftNumbers);
      const rightByKey = leftByKey && keyedIndex(rv, rightNumbers);
      if (leftByKey && rightByKey) {
        frame.type = 3;
        frame.leftKeys = leftByKey.keys();
        frame.rightByKey = rightByKey;
        frame.matched = new Uint8Array(rv.length);
      } else {
        frame.type = 2;
        frame.length = Math.min(lv.length, rv.length);
        if (keyField && (lv.length || rv.length)) keyFallback = true;
      }
    }
    return true;
  }

  const rootIgnore = ignoreMatcher ? ignoreMatcher.initialState : null;
  let depth = enter(left, right, 0, leftNumbers, rightNumbers, rootIgnore, rootIgnore) ? 0 : -1;
  while (depth >= 0) {
    const frame = frames[depth];
    const lv = frame.left;
    const rv = frame.right;
    if (frame.type === 1) {
      if (frame.index < frame.keys.length) {
        const key = frame.keys[frame.index++];
        const nextLeftIgnore = ignoreMatcher ? ignoreMatcher.step(frame.leftIgnore, key) : null;
        if (Object.prototype.hasOwnProperty.call(rv, key)) {
          const nextRightIgnore = ignoreMatcher
            ? (frame.leftIgnore === frame.rightIgnore ? nextLeftIgnore : ignoreMatcher.step(frame.rightIgnore, key))
            : null;
          if (nextLeftIgnore === SUBTREE_IGNORED || nextRightIgnore === SUBTREE_IGNORED) continue;
          leftSegs.push(key);
          rightSegs.push(key);
          if (enter(lv[key], rv[key], depth + 1, frame.leftNumbers?.get(key), frame.rightNumbers?.get(key), nextLeftIgnore, nextRightIgnore)) depth++;
          else { leftSegs.pop(); rightSegs.pop(); }
        } else {
          if (nextLeftIgnore && ignoreMatcher.isIgnored(nextLeftIgnore)) continue;
          leftSegs.push(key);
          record('removed', leftSegs, null, lv[key]);
          leftSegs.pop();
        }
        continue;
      }
      for (const key in rv) {
        if (Object.hasOwn(rv, key) && !Object.hasOwn(lv, key)) {
          const nextRightIgnore = ignoreMatcher ? ignoreMatcher.step(frame.rightIgnore, key) : null;
          if (nextRightIgnore && ignoreMatcher.isIgnored(nextRightIgnore)) continue;
          rightSegs.push(key);
          record('added', null, rightSegs, undefined, rv[key]);
          rightSegs.pop();
        }
      }
    } else if (frame.type === 2) {
      if (frame.index < frame.length) {
        const i = frame.index++;
        const nextLeftIgnore = ignoreMatcher ? ignoreMatcher.step(frame.leftIgnore, i) : null;
        const nextRightIgnore = ignoreMatcher
          ? (frame.leftIgnore === frame.rightIgnore ? nextLeftIgnore : ignoreMatcher.step(frame.rightIgnore, i))
          : null;
        if (nextLeftIgnore === SUBTREE_IGNORED || nextRightIgnore === SUBTREE_IGNORED) continue;
        leftSegs.push(i);
        rightSegs.push(i);
        const key = (frame.leftNumbers || frame.rightNumbers) ? String(i) : null;
        if (enter(lv[i], rv[i], depth + 1, key !== null ? frame.leftNumbers?.get(key) : undefined, key !== null ? frame.rightNumbers?.get(key) : undefined, nextLeftIgnore, nextRightIgnore)) depth++;
        else { leftSegs.pop(); rightSegs.pop(); }
        continue;
      }
      for (let i = frame.length; i < lv.length; i++) {
        const nextLeftIgnore = ignoreMatcher ? ignoreMatcher.step(frame.leftIgnore, i) : null;
        if (nextLeftIgnore && ignoreMatcher.isIgnored(nextLeftIgnore)) continue;
        leftSegs.push(i);
        record('removed', leftSegs, null, lv[i]);
        leftSegs.pop();
      }
      for (let i = frame.length; i < rv.length; i++) {
        const nextRightIgnore = ignoreMatcher ? ignoreMatcher.step(frame.rightIgnore, i) : null;
        if (nextRightIgnore && ignoreMatcher.isIgnored(nextRightIgnore)) continue;
        rightSegs.push(i);
        record('added', null, rightSegs, undefined, rv[i]);
        rightSegs.pop();
      }
    } else {
      if (frame.index < lv.length) {
        const i = frame.index++;
        const j = frame.rightByKey.get(frame.leftKeys.next().value);
        const leftKey = String(i);
        leftSegs.push(leftKey);
        const nextLeftIgnore = ignoreMatcher ? ignoreMatcher.step(frame.leftIgnore, leftKey) : null;
        if (j !== undefined && !frame.matched[j]) {
          frame.matched[j] = 1;
          const rightKey = String(j);
          rightSegs.push(rightKey);
          if (i !== j) {
            if (mappingCount < MAX_PAIRS) {
              pairs.push([toPath(leftSegs), toPath(rightSegs)]);
              mappingCount++;
            } else {
              omitMapping(lv);
              omitMapping(rv);
            }
          }
          const nextRightIgnore = ignoreMatcher ? ignoreMatcher.step(frame.rightIgnore, rightKey) : null;
          if (enter(lv[i], rv[j], depth + 1, frame.leftNumbers?.get(leftKey), frame.rightNumbers?.get(rightKey), nextLeftIgnore, nextRightIgnore)) depth++;
          else { leftSegs.pop(); rightSegs.pop(); }
        } else {
          recordUnpaired(frame, 'left', i, leftSegs);
          if (!nextLeftIgnore || !ignoreMatcher.isIgnored(nextLeftIgnore)) {
            record('removed', leftSegs, null, lv[i]);
          }
          leftSegs.pop();
        }
        continue;
      }
      for (let j = 0; j < rv.length; j++) {
        if (!frame.matched[j]) {
          const rightKey = String(j);
          rightSegs.push(rightKey);
          recordUnpaired(frame, 'right', j, rightSegs);
          const nextRightIgnore = ignoreMatcher ? ignoreMatcher.step(frame.rightIgnore, rightKey) : null;
          if (!nextRightIgnore || !ignoreMatcher.isIgnored(nextRightIgnore)) {
            record('added', null, rightSegs, undefined, rv[j]);
          }
          rightSegs.pop();
        }
      }
    }
    frame.keys = null;
    frame.leftNumbers = null;
    frame.rightNumbers = null;
    frame.leftIgnore = null;
    frame.rightIgnore = null;
    frame.rightByKey = null;
    frame.leftKeys = null;
    frame.matched = null;
    frame.removedRanges = null;
    frame.addedRanges = null;
    leftSegs.pop();
    rightSegs.pop();
    depth--;
  }

  return {
    diffs,
    pairs,
    unpaired,
    pairsTruncated,
    stats,
    truncated,
    keyFallback,
    total: stats.added + stats.removed + stats.changed + stats.typeChanged,
  };
}
