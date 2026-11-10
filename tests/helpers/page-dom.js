import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { appendJsonPath, PATH_SEP } from '../../src/core/json-path.js';
import { createPlainTextRows, createDiffTextRows, safeTextWindow } from '../../src/core/text-lines.js';

// Minimal DOM for exercising real page handlers and lazy rendering in Node.
// Browser layout/paint still needs browser verification.
export class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.events = {};
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
  addEventListener(type, listener) { this.events[type] = listener; }
  removeEventListener(type, listener) { if (this.events[type] === listener) delete this.events[type]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  click() { return this.events.click?.({ target: this }); }
  focus() {}
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

export function loadPage(name, {
  runTask = async () => ({ ok: true, result: {} }),
  expose,
  bodyDataset = {},
  createFileImport = () => ({ reset() {} }),
}) {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const context = vm.createContext({
    document: {
      body: { dataset: bodyDataset },
      getElementById: get,
      createElement: (tag) => new Element(tag),
      createDocumentFragment: () => new Element('#fragment'),
    },
    initializePage: () => {},
    createTaskRunner: () => runTask,
    createFileImport,
    createFeedback: () => ({
      setStatus(text) { get('status').textContent = text; },
      showError(text) { get('error').textContent = text; get('error').hidden = false; },
      hideError() { get('error').textContent = ''; get('error').hidden = true; },
      showParseError(text, response) { get('error').textContent = response.error; get('error').hidden = false; },
    }),
    t: (key) => key,
    appendJsonPath,
    PATH_SEP,
    createPlainTextRows, createDiffTextRows, safeTextWindow,
    getComputedStyle: () => ({ lineHeight: '21px', fontSize: '13px', font: '13px monospace', fontFamily: 'monospace', paddingTop: '0', paddingBottom: '0', paddingLeft: '0', paddingRight: '0' }),
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout,
    ResizeObserver: class { observe() {} disconnect() {} },
    copyText: async () => {},
    setTimeout,
    clearTimeout,
  });
  const treeSource = readFileSync(new URL('../../src/shared/json-tree.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(treeSource, context);
  const virtualTreeSource = readFileSync(new URL('../../src/shared/virtual-tree.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(virtualTreeSource, context);
  const virtualTextSource = readFileSync(new URL('../../src/shared/virtual-text.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(virtualTextSource, context);
  const textInputSource = readFileSync(new URL('../../src/shared/text-input.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(textInputSource, context);
  const source = readFileSync(new URL(`../../src/pages/${name}.js`, import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '');
  vm.runInContext(source + `\nglobalThis.page = ${expose};`, context);
  return { ...context.page, get };
}
