import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import vm from 'node:vm';
import { Element } from '../tests/helpers/page-dom.js';
import { appendJsonPath, createChildPathIndex, PATH_SEP } from '../src/core/json-path.js';
import { createTreeModel } from '../src/core/tree-model.js';
import { createDocumentSession } from '../src/shared/document-session.js';
import { createComparisonSession } from '../src/shared/comparison-session.js';

// Pure rendering fixture: real page functions + minimal DOM, no browser layout
// or paint. Heap deltas include unreclaimed temporary allocations, not RSS.
// node --expose-gc bench/tree-rendering.mjs [git revision]
const revision = process.argv[2];
const read = (path) => revision
  ? execFileSync('git', ['show', `${revision}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  : readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const compile = (source) => source
  .replace(/^(?:import .*;|export \{.*\} from .*;)\n/gm, '')
  .replace(/^export /gm, '');

function createRunner() {
  return Object.assign(async () => ({ ok: true, result: {} }), { cancel: () => false });
}

function page(name) {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: get, createElement: (tag) => new Element(tag), createDocumentFragment: () => new Element('#fragment') },
    initializePage() {}, createTaskRunner: createRunner,
    createDocumentSession: (options) => createDocumentSession({ ...options, createRunner }),
    createComparisonSession: (options) => createComparisonSession({ ...options, createRunner }),
    createFileImport: () => ({ reset() {} }),
    createTextInput: (element) => ({
      getText: () => element.value,
      setText: (text) => { element.value = text; },
      selectPosition() {},
      bindEvents() {},
      isLarge: () => false,
    }),
    LARGE_INPUT_THRESHOLD: 262144,
    createVirtualTextView: () => ({ setText() {}, setDiff() {}, refresh() {}, clear() {} }),
    createFeedback: () => ({ setStatus() {}, showError() {}, hideError() {}, showParseError() {} }),
    createBusyFeedback: () => () => {},
    t: (key) => key, appendJsonPath, createChildPathIndex, createTreeModel, PATH_SEP,
    copyText: async () => {}, setTimeout, clearTimeout,
  });
  vm.runInContext(compile(read('src/shared/json-tree.js')), context);
  try { vm.runInContext(compile(read('src/shared/virtual-tree.js')), context); }
  catch (error) { if (!revision || error.status !== 128) throw error; }
  const expose = name === 'formatter'
    ? '{state,renderTree,applyLevel,getTree:()=>typeof treeView === "undefined" ? null : treeView}'
    : '{state,buildIndexes,renderTrees,getTree:()=>typeof treeViews === "undefined" ? null : treeViews}';
  vm.runInContext(compile(read(`src/pages/${name}.js`)) + `\nglobalThis.page = ${expose};`, context);
  return { ...context.page, get };
}

function countElements(root) {
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    count++;
    for (const child of current.children) stack.push(child);
  }
  return count;
}

const cases = {
  'expand-200x200': () => {
    const p = page('formatter');
    p.state.data = Array.from({ length: 200 }, () => Array(200).fill(1));
    return { p, run: () => p.applyLevel('all'), roots: ['tree'] };
  },
  'reach-last-of-120k-primitives': () => {
    const p = page('formatter');
    p.state.data = Array(120000).fill(1);
    return { p, roots: ['tree'], run() {
      p.renderTree();
      if (p.getTree()) p.getTree().reveal('/119999');
      else {
        const children = p.get('tree').children[0].children[0].children[1];
        while (children.children.at(-1)?.className === 'more') children.children.at(-1).click();
      }
    } };
  },
  'dense-diff-5000x200': () => {
    const p = page('compare');
    const left = Array(200).fill(1);
    const right = Array(200).fill(1);
    right[199] = 2;
    p.state.result = {
      leftData: Array(5000).fill(left), rightData: Array(5000).fill(right), pairs: [],
      diffs: Array.from({ length: 5000 }, (_, i) => ({ type: 'changed', leftPath: `/${i}/199`, rightPath: `/${i}/199` })),
    };
    // New pages fetch and assign tree data separately from the lazy indexes.
    p.state.leftData = p.state.result.leftData;
    p.state.rightData = p.state.result.rightData;
    p.buildIndexes();
    return { p, run: () => p.renderTrees(), roots: ['tree-left', 'tree-right'] };
  },
  'depth-1000': () => {
    const p = page('formatter');
    let data = 1;
    for (let i = 0; i < 1000; i++) data = [data];
    p.state.data = data;
    return { p, run: () => p.applyLevel('all'), roots: ['tree'] };
  },
};

for (const [name, create] of Object.entries(cases)) {
  const { p, run, roots } = create();
  globalThis.gc?.();
  const heap = process.memoryUsage().heapUsed;
  const started = performance.now();
  let error;
  try { run(); } catch (caught) { error = caught.message; }
  const ms = performance.now() - started;
  const heapDeltaMiB = (process.memoryUsage().heapUsed - heap) / 1024 / 1024;
  const tree = p.getTree();
  const logicalRows = tree?.rowCount ?? (tree ? tree.left.rowCount + tree.right.rowCount : undefined);
  if (!revision) {
    const expected = { 'expand-200x200': 40402, 'reach-last-of-120k-primitives': 120002, 'dense-diff-5000x200': 2020004, 'depth-1000': 2001 }[name];
    if (error || logicalRows !== expected) throw new Error(`${name}: ${error || `Expected ${expected} logical rows, got ${logicalRows}`}`);
  }
  console.log(JSON.stringify({
    revision: revision || 'working-tree', name, ms: +ms.toFixed(2),
    heapDeltaMiB: +heapDeltaMiB.toFixed(2),
    elements: roots.reduce((count, id) => count + countElements(p.get(id)), 0),
    logicalRows,
    legacyEntries: p.state.renderedCount, legacyLimited: p.state.renderLimited,
    leftEntries: p.state.elemMap?.left.size, rightEntries: p.state.elemMap?.right.size, error,
  }));
}
