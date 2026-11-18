import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createTreeModel } from '../../src/core/tree-model.js';
import { appendJsonPath, PATH_SEP, createChildPathIndex } from '../../src/core/json-path.js';
import { createPlainTextRows, createDiffTextRows, safeTextWindow } from '../../src/core/text-lines.js';
import { createDocumentSession } from '../../src/shared/document-session.js';
import { createComparisonSession } from '../../src/shared/comparison-session.js';

// Minimal DOM for exercising real page handlers and lazy rendering in Node.
// Browser layout/paint still needs browser verification.
export class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.events = {};
    this.listeners = new Map();
    this.className = '';
    this.value = '';
    this.textContent = '';
    this.clientHeight = 480;
    this.clientWidth = 640;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.scrollWidth = 0;
    this.attributes = {};
    this.classList = {
      add: (...names) => { for (const name of names) if (!this.classList.contains(name)) this.className += ' ' + name; },
      remove: (...names) => { this.className = this.className.split(' ').filter((part) => !names.includes(part)).join(' '); },
      contains: (name) => this.className.split(' ').includes(name),
      toggle: (name, enabled) => { this.classList[enabled ? 'add' : 'remove'](name); },
    };
  }
  appendChild(child) {
    if (child.tagName === '#fragment') {
      for (const item of child.children) this.appendChild(item);
    } else {
      child.parentElement = this;
      this.children.push(child);
    }
    return child;
  }
  set textContent(value) { this.children = []; this._textContent = String(value); }
  get textContent() { return this._textContent + this.children.map((child) => child.textContent).join(''); }
  get firstChild() {
    return this.children[0] || (this._textContent ? { nodeType: 3, parentElement: this, textContent: this._textContent } : null);
  }
  append(...children) { for (const child of children) this.appendChild(child); }
  contains(element) { return element === this || this.children.some((child) => child.contains(element)); }
  getContext() { return { font: '13px monospace', measureText: (text) => ({ width: text.length * 8 }) }; }
  set innerHTML(value) {
    this._textContent = '';
    for (const child of this.children) child.parentElement = null;
    this.children = [];
  }
  replaceChildren(...children) {
    this.innerHTML = '';
    for (const child of children) this.appendChild(child);
  }
  before(node) {
    const parent = this.parentElement;
    const index = parent.children.indexOf(this);
    const nodes = node.tagName === '#fragment' ? node.children : [node];
    for (const child of nodes) child.parentElement = parent;
    parent.children.splice(index, 0, ...nodes);
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    this.events[type] = (event) => {
      let result;
      for (const callback of this.listeners.get(type)) result = callback(event);
      return result;
    };
  }
  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type);
    listeners?.delete(listener);
    if (!listeners?.size) delete this.events[type];
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  click() { return this.events.click?.({ target: this }); }
  focus() { this.focused = true; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  scrollIntoView() {}
  remove() {
    const parent = this.parentElement;
    if (parent) parent.children = parent.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  querySelectorAll(selector) {
    const classes = selector.split('.').filter(Boolean);
    const found = [];
    for (const child of this.children) {
      if (classes.every((name) => child.classList.contains(name))) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function createDocument() {
  return {
    createElement: (tag) => new Element(tag),
    createDocumentFragment: () => new Element('#fragment'),
  };
}

// Keep the document installed until asynchronous component work has settled.
export async function withDom(run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = createDocument();
  try { return await run(); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete globalThis.document;
  }
}

export function loadPage(name, {
  runTask = async () => ({ ok: true, result: {} }),
  expose,
  bodyDataset = {},
  createFileImport = () => ({ reset() {} }),
  createTaskRunner,
  translate = (key) => key,
  copyText = async () => {},
}) {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const selection = {
    ranges: [],
    removeAllRanges() { this.ranges = []; },
    addRange(range) { this.ranges.push(range); },
  };
  const createRunner = createTaskRunner || (() => Object.assign(runTask, { cancel: runTask.cancel || (() => false) }));
  const context = vm.createContext({
    document: {
      ...createDocument(),
      body: { dataset: bodyDataset },
      getElementById: get,
      getSelection: () => selection,
      createRange: () => ({
        setStart(node, offset) { this.startContainer = node; this.startOffset = offset; },
        setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; },
      }),
    },
    initializePage: () => {},
    createTaskRunner: createRunner,
    createDocumentSession: (options) => createDocumentSession({ ...options, createRunner }),
    createComparisonSession: (options) => createComparisonSession({ ...options, createRunner }),
    createFileImport,
    t: translate,
    appendJsonPath, createChildPathIndex, createTreeModel,
    PATH_SEP,
    createPlainTextRows, createDiffTextRows, safeTextWindow,
    getComputedStyle: () => ({ lineHeight: '21px', fontSize: '13px', font: '13px monospace', fontFamily: 'monospace', paddingTop: '0', paddingBottom: '0', paddingLeft: '0', paddingRight: '0' }),
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout,
    ResizeObserver: class { observe() {} disconnect() {} },
    copyText,
    setTimeout,
    clearTimeout,
  });
  for (const module of ['json-tree', 'virtual-tree', 'remote-tree', 'virtual-text', 'text-input', 'feedback']) {
    let source = readFileSync(new URL(`../../src/shared/${module}.js`, import.meta.url), 'utf8')
      .replace(/^(?:import .*;|export \{.*\} from .*;)\n/gm, '').replace(/^export /gm, '');
    // Remote and local tree modules intentionally have private names in common.
    if (module === 'remote-tree') {
      source = '(function () {' + source + '\nglobalThis.createRemoteTree = createRemoteTree; })()';
    }
    vm.runInContext(source, context, { filename: `${module}.js` });
  }
  const source = readFileSync(new URL(`../../src/pages/${name}.js`, import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '');
  vm.runInContext(source + `\nglobalThis.page = ${expose};`, context);
  return { ...context.page, get, selection };
}
