import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { initAutoFormatSettings, AUTO_FORMAT_ORIGINS, PLAIN_TEXT_STORAGE_KEY } from '../src/shared/auto-format-settings.js';
import { Element } from './helpers/page-dom.js';

const source = readFileSync(new URL('../src/shared/sidebar.js', import.meta.url), 'utf8');
const key = 'json-toolbox.sidebar';

function openPage({ values = new Map(), blocked = '', mobile = false, messages = null } = {}) {
  const documentEvents = {};
  const windowEvents = {};
  const toggleEvents = {};
  const label = { dataset: {}, textContent: 'Collapse sidebar' };
  const button = {
    dataset: {},
    title: 'Collapse sidebar (Cmd/Ctrl + B)',
    attributes: { 'aria-expanded': 'true' },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name]; },
    addEventListener(name, handler) { toggleEvents[name] = handler; },
    querySelector: (selector) => (selector === '.sidebar-toggle-label' ? label : null),
    click() { toggleEvents.click?.({ target: this }); },
  };
  const menu = { hidden: true };
  const trigger = {
    attributes: { 'aria-expanded': 'false' },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name]; },
  };
  const controls = {
    '#sidebar-toggle': button,
    '#theme-switch': menu,
    '#theme-trigger': trigger,
  };
  const storage = {
    getItem(name) {
      if (blocked === 'read') throw new Error('Storage read blocked');
      return values.get(name) ?? null;
    },
    setItem(name, value) {
      if (blocked === 'write') throw new Error('Storage write blocked');
      values.set(name, value);
    },
  };
  const document = {
    documentElement: { dataset: {} },
    querySelector: (selector) => controls[selector] ?? null,
    addEventListener: (name, handler) => { documentEvents[name] = handler; },
  };
  const window = {
    get localStorage() {
      if (blocked === 'access') throw new Error('Storage unavailable');
      return storage;
    },
    matchMedia: (query) => ({ matches: mobile && query === '(max-width: 780px)' }),
    addEventListener: (name, handler) => { windowEvents[name] = handler; },
  };
  const context = { document, window };
  if (messages) {
    context.chrome = { i18n: { getMessage: (name) => messages[name] || '' } };
  }
  vm.runInNewContext(source, context);
  const startupState = document.documentElement.dataset.sidebar;
  documentEvents.DOMContentLoaded();
  return {
    startupState,
    get state() { return document.documentElement.dataset.sidebar; },
    get expanded() { return button.getAttribute('aria-expanded'); },
    get label() { return label.textContent; },
    get labelKey() { return label.dataset.i18n; },
    get title() { return button.title; },
    get titleKey() { return button.dataset.i18nTitle; },
    get menuHidden() { return menu.hidden; },
    get themeExpanded() { return trigger.getAttribute('aria-expanded'); },
    openThemeMenu() {
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
    },
    clickToggle: () => button.click(),
    keydown: (event) => {
      let prevented = false;
      documentEvents.keydown?.({
        defaultPrevented: false,
        isComposing: false,
        repeat: false,
        altKey: false,
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        ...event,
        preventDefault() { prevented = true; },
      });
      return prevented;
    },
    storageEvent: (event) => windowEvents.storage({ storageArea: storage, ...event }),
    values,
  };
}

test('new users and invalid preferences start expanded without writing storage', () => {
  for (const saved of [undefined, '', 'hidden', 'rail']) {
    const values = new Map(saved === undefined ? [] : [[key, saved]]);
    const before = [...values];
    const page = openPage({ values });
    assert.equal(page.startupState, 'expanded');
    assert.equal(page.state, 'expanded');
    assert.equal(page.expanded, 'true');
    assert.equal(page.labelKey, 'sidebarCollapse');
    assert.equal(page.titleKey, 'sidebarCollapseTitle');
    assert.deepEqual([...values], before);
  }
});

test('toggling sidebar persists collapsed/expanded state across pages without disturbing other keys', () => {
  const values = new Map([['unrelated', 'keep']]);
  const page = openPage({ values });

  page.clickToggle();
  assert.equal(page.state, 'collapsed');
  assert.equal(page.expanded, 'false');
  assert.equal(page.label, 'Expand sidebar');
  assert.equal(page.labelKey, 'sidebarExpand');
  assert.equal(page.title, 'Expand sidebar (Cmd/Ctrl + B)');
  assert.equal(page.titleKey, 'sidebarExpandTitle');
  assert.equal(values.get(key), 'collapsed');
  assert.deepEqual([...values.keys()], ['unrelated', key]);

  const nextPage = openPage({ values });
  assert.equal(nextPage.startupState, 'collapsed');
  assert.equal(nextPage.expanded, 'false');
  assert.equal(nextPage.label, 'Expand sidebar');

  nextPage.clickToggle();
  assert.equal(nextPage.state, 'expanded');
  assert.equal(nextPage.expanded, 'true');
  assert.equal(nextPage.label, 'Collapse sidebar');
  assert.equal(values.get(key), 'expanded');
});

test('Cmd/Ctrl + B toggles on desktop, ignores modifiers/repeat/composing and mobile viewports', () => {
  const page = openPage();
  assert.equal(page.keydown({ ctrlKey: true, key: 'b' }), true);
  assert.equal(page.state, 'collapsed');
  assert.equal(page.keydown({ metaKey: true, key: 'B' }), true);
  assert.equal(page.state, 'expanded');

  for (const ignored of [
    { ctrlKey: true, altKey: true, key: 'b' },
    { ctrlKey: true, shiftKey: true, key: 'b' },
    { ctrlKey: true, metaKey: true, key: 'b' },
    { ctrlKey: true, repeat: true, key: 'b' },
    { ctrlKey: true, isComposing: true, key: 'b' },
    { ctrlKey: true, defaultPrevented: true, key: 'b' },
    { key: 'b' },
  ]) {
    assert.equal(page.keydown(ignored), false);
    assert.equal(page.state, 'expanded');
  }

  const mobilePage = openPage({ mobile: true });
  assert.equal(mobilePage.keydown({ ctrlKey: true, key: 'b' }), false);
  assert.equal(mobilePage.state, 'expanded');
});

test('toggling sidebar closes an open theme menu', () => {
  const page = openPage();
  page.openThemeMenu();
  assert.equal(page.menuHidden, false);
  assert.equal(page.themeExpanded, 'true');
  page.clickToggle();
  assert.equal(page.menuHidden, true);
  assert.equal(page.themeExpanded, 'false');
});

test('open pages follow sidebar changes and removals in local storage only', () => {
  const page = openPage({ values: new Map([[key, 'expanded']]) });
  page.storageEvent({ key, newValue: 'collapsed' });
  assert.equal(page.state, 'collapsed');
  assert.equal(page.expanded, 'false');
  page.storageEvent({ key: 'unrelated', newValue: 'expanded' });
  page.storageEvent({ key, newValue: 'expanded', storageArea: {} });
  assert.equal(page.state, 'collapsed');
  for (const event of [{ key, newValue: null }, { key, newValue: 'invalid' }, { key: null, newValue: null }]) {
    page.clickToggle();
    page.storageEvent({ key, newValue: 'collapsed' });
    assert.equal(page.state, 'collapsed');
    page.storageEvent(event);
    assert.equal(page.state, 'expanded');
    assert.equal(page.expanded, 'true');
  }
});

test('blocked storage does not break initial rendering or manual toggling', () => {
  for (const blocked of ['access', 'read', 'write']) {
    const page = openPage({ blocked });
    assert.equal(page.startupState, 'expanded');
    page.clickToggle();
    assert.equal(page.state, 'collapsed');
    assert.equal(page.expanded, 'false');
    page.clickToggle();
    assert.equal(page.state, 'expanded');
  }
});

test('extension i18n messages update toggle label and title on state changes', () => {
  const messages = {
    sidebarCollapse: '收起侧边栏',
    sidebarExpand: '展开侧边栏',
    sidebarCollapseTitle: '收起侧边栏（Cmd/Ctrl + B）',
    sidebarExpandTitle: '展开侧边栏（Cmd/Ctrl + B）',
  };
  const page = openPage({ messages });
  assert.equal(page.label, messages.sidebarCollapse);
  assert.equal(page.title, messages.sidebarCollapseTitle);
  page.clickToggle();
  assert.equal(page.label, messages.sidebarExpand);
  assert.equal(page.title, messages.sidebarExpandTitle);
});

function setupSettings({ granted = [], requestResult = true, plainText = false, fileAllowed = true } = {}) {
  const autoToggle = new Element('button');
  const plainToggle = new Element('button');
  const subEl = new Element('div');
  const fileHintEl = new Element('p');
  autoToggle.setAttribute('aria-checked', 'false');
  plainToggle.setAttribute('aria-checked', 'false');
  subEl.hidden = true;
  fileHintEl.hidden = true;

  const elements = {
    'auto-format-pages': autoToggle,
    'auto-format-plain-text': plainToggle,
    'auto-format-sub': subEl,
    'file-access-hint': fileHintEl,
  };
  let grantedOrigins = new Set(granted === true ? AUTO_FORMAT_ORIGINS : (granted || []));
  let storedPlain = plainText;
  const unregistered = [];
  const runtimeMessages = [];
  const listeners = { permAdded: [], permRemoved: [], storageChanged: [] };

  const prevDoc = globalThis.document;
  const prevChrome = globalThis.chrome;
  globalThis.document = { getElementById: (id) => elements[id] || null };
  globalThis.chrome = {
    permissions: {
      async getAll() {
        return { origins: [...grantedOrigins] };
      },
      async contains({ origins }) {
        return origins.every((o) => grantedOrigins.has(o));
      },
      async request({ origins }) {
        assert.deepEqual(origins, AUTO_FORMAT_ORIGINS);
        if (requestResult) grantedOrigins = new Set(AUTO_FORMAT_ORIGINS);
        return requestResult;
      },
      async remove({ origins }) {
        origins.forEach((o) => grantedOrigins.delete(o));
        return true;
      },
      onAdded: { addListener: (fn) => listeners.permAdded.push(fn) },
      onRemoved: { addListener: (fn) => listeners.permRemoved.push(fn) },
    },
    runtime: {
      async sendMessage(msg) {
        runtimeMessages.push(msg);
        return { ok: true };
      },
    },
    storage: {
      local: {
        async get(key) { return { [key]: storedPlain }; },
        async set(obj) { storedPlain = obj[PLAIN_TEXT_STORAGE_KEY]; },
      },
      onChanged: { addListener: (fn) => listeners.storageChanged.push(fn) },
    },
    scripting: {
      async unregisterContentScripts({ ids }) { unregistered.push(...ids); },
    },
    extension: {
      isAllowedFileSchemeAccess(cb) { cb(fileAllowed); },
    },
  };

  const controller = initAutoFormatSettings();
  return {
    autoToggle,
    plainToggle,
    subEl,
    fileHintEl,
    unregistered,
    runtimeMessages,
    getGranted: () => [...grantedOrigins],
    listeners,
    controller,
    restore() {
      globalThis.document = prevDoc;
      globalThis.chrome = prevChrome;
    },
  };
}

test('auto-format settings reflect permissions, handle denied requests and partial grants cleanly', async () => {
  const denied = setupSettings({ granted: false, requestResult: false });
  try {
    await new Promise(setImmediate);
    assert.equal(denied.autoToggle.getAttribute('aria-checked'), 'false');
    assert.equal(denied.subEl.hidden, true);

    denied.autoToggle.click();
    await new Promise(setImmediate);
    assert.equal(denied.autoToggle.getAttribute('aria-checked'), 'false');
    assert.equal(denied.subEl.hidden, true);
  } finally {
    denied.restore();
  }

  const allowed = setupSettings({ granted: false, requestResult: true, fileAllowed: false });
  try {
    await new Promise(setImmediate);
    allowed.autoToggle.click();
    await new Promise(setImmediate);
    assert.equal(allowed.autoToggle.getAttribute('aria-checked'), 'true');
    assert.equal(allowed.subEl.hidden, false);
    assert.equal(allowed.fileHintEl.hidden, false);
    assert.deepEqual(allowed.runtimeMessages, [{ type: 'SYNC_AUTO_FORMAT' }]);

    allowed.plainToggle.click();
    await new Promise(setImmediate);
    assert.equal(allowed.plainToggle.getAttribute('aria-checked'), 'true');

    allowed.autoToggle.click();
    await new Promise(setImmediate);
    assert.equal(allowed.autoToggle.getAttribute('aria-checked'), 'false');
    assert.equal(allowed.subEl.hidden, true);
    assert.deepEqual(allowed.unregistered, ['json-toolbox-auto-format']);
    assert.deepEqual(allowed.runtimeMessages, [{ type: 'SYNC_AUTO_FORMAT' }, { type: 'SYNC_AUTO_FORMAT' }]);
  } finally {
    allowed.restore();
  }

  const partial = setupSettings({ granted: ['https://*/*'], fileAllowed: false });
  try {
    await new Promise(setImmediate);
    assert.equal(partial.autoToggle.getAttribute('aria-checked'), 'true');
    assert.equal(partial.subEl.hidden, false);
    assert.equal(partial.fileHintEl.hidden, true);

    partial.autoToggle.click();
    await new Promise(setImmediate);
    assert.equal(partial.autoToggle.getAttribute('aria-checked'), 'false');
    assert.deepEqual(partial.getGranted(), []);
    assert.deepEqual(partial.unregistered, ['json-toolbox-auto-format']);
  } finally {
    partial.restore();
  }
});
