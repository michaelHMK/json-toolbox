import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import vm from 'node:vm';
import { Element } from '../tests/helpers/page-dom.js';
import { createTaskHandler } from '../src/worker/tasks.js';
import { MODEL_OPTIONS } from '../src/core/tree-model.js';
import { PREVIEW_LIMIT, previewPrefix } from '../src/core/preview.js';
import { hasNonWhitespace } from '../src/core/text-lines.js';
import { createDocumentSession } from '../src/shared/document-session.js';
import { createComparisonSession } from '../src/shared/comparison-session.js';

// Pure rendering fixture: real page functions + real Worker task handler + minimal DOM,
// no browser layout or paint. Heap deltas include unreclaimed temporary allocations, not RSS.
// node --expose-gc bench/tree-rendering.mjs
const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const compile = (source) => source
  .replace(/^(?:import .*;|export \{.*\} from .*;)\n/gm, '')
  .replace(/^export /gm, '');

function page(name) {
  const handler = createTaskHandler();
  const createRunner = () => Object.assign(
    async (action, payload = {}) => handler({ action, ...payload }),
    { cancel: () => false },
  );
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
      hasContent: () => hasNonWhitespace(element.value),
      selectPosition() {},
      bindEvents() {},
      clear() { element.value = ''; },
      focus() {},
      isLarge: () => false,
    }),
    LARGE_INPUT_THRESHOLD: 262144,
    createVirtualTextView: () => ({ setText() {}, setDiff() {}, refresh() {}, clear() {} }),
    createFeedback: () => ({ setStatus() {}, showError() {}, hideError() {}, showParseError() {} }),
    createBusyFeedback: () => () => {},
    t: (key) => key, MODEL_OPTIONS,
    PREVIEW_LIMIT, previewPrefix, hasNonWhitespace,
    copyText: async () => {}, setTimeout, clearTimeout,
  });
  vm.runInContext(compile(read('src/shared/virtual-tree.js')), context);
  const expose = name === 'formatter'
    ? '{state,setView,ensureTreeData,renderTree,applyLevel,getTree:()=>treeView}'
    : '{state,doCompare,destroyTrees,refreshTrees,renderTrees,getTree:()=>treeViews}';
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
  'expand-200x200': async () => {
    const p = page('formatter');
    p.get('input').value = JSON.stringify(Array.from({ length: 200 }, () => Array(200).fill(1)));
    await p.setView('tree');
    return { p, run: () => p.applyLevel('all'), roots: ['tree'] };
  },
  'reach-last-of-120k-primitives': async () => {
    const p = page('formatter');
    p.get('input').value = JSON.stringify(Array(120000).fill(1));
    await p.ensureTreeData();
    return { p, roots: ['tree'], async run() {
      await p.renderTree();
      await p.getTree().reveal('/119999');
    } };
  },
  'dense-diff-5000x200': async () => {
    const p = page('compare');
    const left = Array(200).fill(1);
    const right = Array(200).fill(1);
    right[199] = 2;
    p.get('input-left').value = JSON.stringify(Array(5000).fill(left));
    p.get('input-right').value = JSON.stringify(Array(5000).fill(right));
    await p.doCompare();
    p.destroyTrees();
    p.state.treesDirty = true;
    return { p, run: () => p.refreshTrees(), roots: ['tree-left', 'tree-right'] };
  },
  'depth-1000': async () => {
    const p = page('formatter');
    let data = 1;
    for (let i = 0; i < 1000; i++) data = [data];
    p.get('input').value = JSON.stringify(data);
    await p.setView('tree');
    return { p, run: () => p.applyLevel('all'), roots: ['tree'] };
  },
};

for (const [name, create] of Object.entries(cases)) {
  const { p, run, roots } = await create();
  globalThis.gc?.();
  const heap = process.memoryUsage().heapUsed;
  const started = performance.now();
  let error;
  try { await run(); } catch (caught) { error = caught.message; }
  const ms = performance.now() - started;
  const heapDeltaMiB = (process.memoryUsage().heapUsed - heap) / 1024 / 1024;
  const tree = p.getTree();
  const logicalRows = tree?.rowCount ?? (tree ? tree.left.rowCount + tree.right.rowCount : undefined);
  const expected = { 'expand-200x200': 40402, 'reach-last-of-120k-primitives': 120002, 'dense-diff-5000x200': 2020004, 'depth-1000': 2001 }[name];
  if (error || logicalRows !== expected) throw new Error(`${name}: ${error || `Expected ${expected} logical rows, got ${logicalRows}`}`);
  console.log(JSON.stringify({
    revision: 'working-tree', name, ms: +ms.toFixed(2),
    heapDeltaMiB: +heapDeltaMiB.toFixed(2),
    elements: roots.reduce((count, id) => count + countElements(p.get(id)), 0),
    logicalRows,
  }));
}
