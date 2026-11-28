import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');

function setupBackground({ executeScript, grantedOrigins = [], registeredScripts = [] } = {}) {
  const listeners = {
    actionClicked: [],
    installed: [],
    startup: [],
    menuClicked: [],
    messages: [],
    permAdded: [],
    permRemoved: [],
  };
  const menus = new Map();
  let createCalls = 0;
  let removeAllCalls = 0;
  const sessionStore = new Map();
  const openedTabs = [];
  const sentMessages = [];
  const dynamicScripts = new Map(registeredScripts.map((s) => [s.id, s]));
  let currentOrigins = new Set(grantedOrigins);

  const chrome = {
    runtime: {
      lastError: null,
      getURL: (path) => `chrome-extension://test-ext-id/${path}`,
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      onMessage: { addListener: (fn) => listeners.messages.push(fn) },
    },
    i18n: {
      getMessage: (key) => ({
        menuOpenSelection: 'Open selection in JSON Toolbox',
        menuFormatPage: 'Format JSON on this page',
      })[key] || '',
    },
    action: {
      onClicked: { addListener: (fn) => listeners.actionClicked.push(fn) },
    },
    contextMenus: {
      removeAll(cb) {
        removeAllCalls++;
        menus.clear();
        cb?.();
      },
      create(opts, cb) {
        createCalls++;
        menus.set(opts.id, opts);
        cb?.();
      },
      onClicked: { addListener: (fn) => listeners.menuClicked.push(fn) },
    },
    permissions: {
      async getAll() { return { origins: [...currentOrigins] }; },
      async contains({ origins = [] }) { return origins.every((o) => currentOrigins.has(o)); },
      onAdded: { addListener: (fn) => listeners.permAdded.push(fn) },
      onRemoved: { addListener: (fn) => listeners.permRemoved.push(fn) },
    },
    scripting: {
      executeScript: executeScript || (async () => [{ result: '{"a": 1}' }]),
      async getRegisteredContentScripts({ ids } = {}) {
        return ids ? ids.map((id) => dynamicScripts.get(id)).filter(Boolean) : [...dynamicScripts.values()];
      },
      async registerContentScripts(specs) {
        for (const s of specs) {
          if (dynamicScripts.has(s.id)) throw new Error('Duplicate script ID');
          dynamicScripts.set(s.id, s);
        }
      },
      async updateContentScripts(specs) {
        for (const s of specs) dynamicScripts.set(s.id, s);
      },
      async unregisterContentScripts({ ids }) {
        for (const id of ids) dynamicScripts.delete(id);
      },
    },
    storage: {
      session: {
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v);
        },
        async get(key) {
          if (key === null) return Object.fromEntries(sessionStore.entries());
          return sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {};
        },
        async remove(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) sessionStore.delete(k);
        },
      },
    },
    tabs: {
      async create(opts) {
        openedTabs.push(opts);
        return { id: openedTabs.length + 100, ...opts };
      },
      async sendMessage(tabId, msg) {
        sentMessages.push({ tabId, msg });
        return { ok: true };
      },
    },
  };

  const context = vm.createContext({
    chrome,
    TextEncoder,
    crypto: globalThis.crypto,
    URL,
    URLSearchParams,
  });
  vm.runInContext(source + '\nglobalThis.__bg = { handleContextMenuClick, readActiveSelectionInPage, syncAutoFormatScript };', context);

  return {
    listeners,
    menus,
    sessionStore,
    openedTabs,
    sentMessages,
    dynamicScripts,
    setGrantedOrigins(origins) { currentOrigins = new Set(origins); },
    get createCalls() { return createCalls; },
    get removeAllCalls() { return removeAllCalls; },
    handleContextMenuClick: context.__bg.handleContextMenuClick,
    readActiveSelectionInPage: context.__bg.readActiveSelectionInPage,
    syncAutoFormatScript: context.__bg.syncAutoFormatScript,
    context,
  };
}

test('onInstalled registers context menu idempotently without duplicate entries', () => {
  const bg = setupBackground();
  bg.listeners.installed.forEach((fn) => fn({ reason: 'install' }));
  bg.listeners.installed.forEach((fn) => fn({ reason: 'update' }));
  assert.equal(bg.removeAllCalls, 2);
  assert.equal(bg.createCalls, 4);
  assert.equal(bg.menus.size, 2);
  assert.deepEqual(structuredClone(bg.menus.get('open-selection')), {
    id: 'open-selection',
    title: 'Open selection in JSON Toolbox',
    contexts: ['selection'],
  });
  assert.deepEqual(structuredClone(bg.menus.get('format-page-json')), {
    id: 'format-page-json',
    title: 'Format JSON on this page',
    contexts: ['page'],
  });
});

test('context menu reads selection via executeScript, stores one-time token, and opens tab beside opener', async () => {
  let capturedCall;
  const bg = setupBackground({
    async executeScript(opts) {
      capturedCall = opts;
      return [{ result: '{\n  "exact": true\n}' }];
    },
  });
  await bg.handleContextMenuClick(
    { menuItemId: 'open-selection', frameId: 2, selectionText: '{ "exact": true }' },
    { id: 42, index: 3 },
  );
  assert.deepEqual(structuredClone(capturedCall.target), { tabId: 42, frameIds: [2] });
  assert.equal(bg.openedTabs.length, 1);
  assert.equal(bg.openedTabs[0].index, 4);
  assert.equal(bg.openedTabs[0].openerTabId, 42);
  const url = new URL(bg.openedTabs[0].url);
  assert.equal(url.pathname, '/formatter.html');
  const token = url.searchParams.get('import');
  assert.ok(token);
  const entry = structuredClone(bg.sessionStore.get(`selection:${token}`));
  assert.equal(entry.text, '{\n  "exact": true\n}');
  assert.equal(entry.normalized, false);
  assert.equal(typeof entry.createdAt, 'number');
});

test('readActiveSelectionInPage extracts textarea selectionRange accurately', () => {
  const bg = setupBackground();
  const textarea = {
    tagName: 'TEXTAREA',
    value: 'prefix {"k": 1}\nsuffix',
    selectionStart: 7,
    selectionEnd: 15,
  };
  bg.context.document = { activeElement: textarea };
  bg.context.window = { getSelection: () => ({ toString: () => '' }) };
  assert.equal(bg.readActiveSelectionInPage(), '{"k": 1}');
});

test('falls back to info.selectionText with normalized=true when executeScript is blocked', async () => {
  const bg = setupBackground({
    async executeScript() {
      throw new Error('Cannot access a chrome:// URL');
    },
  });
  await bg.handleContextMenuClick(
    { menuItemId: 'open-selection', selectionText: '{"fallback": 1}' },
    { id: 7, index: 0 },
  );
  assert.equal(bg.openedTabs.length, 1);
  const token = new URL(bg.openedTabs[0].url).searchParams.get('import');
  const fallbackEntry = structuredClone(bg.sessionStore.get(`selection:${token}`));
  assert.equal(fallbackEntry.text, '{"fallback": 1}');
  assert.equal(fallbackEntry.normalized, true);
  assert.equal(typeof fallbackEntry.createdAt, 'number');
});

test('rejects selections exceeding 10 MB session storage limit without writing session storage', async () => {
  const huge = '"' + 'a'.repeat(10 * 1024 * 1024) + '"';
  const bg = setupBackground({
    async executeScript() {
      return [{ result: huge }];
    },
  });
  await bg.handleContextMenuClick(
    { menuItemId: 'open-selection', selectionText: 'ignored' },
    { id: 9, index: 1 },
  );
  assert.equal(bg.sessionStore.size, 0);
  assert.equal(bg.openedTabs.length, 1);
  assert.equal(bg.openedTabs[0].url, 'chrome-extension://test-ext-id/formatter.html?importError=tooLarge');
  assert.equal(bg.openedTabs[0].index, 2);
  assert.equal(bg.openedTabs[0].openerTabId, 9);
});

test('syncAutoFormatScript reconciles dynamic content script with permission additions, removals and startup', async () => {
  const bg = setupBackground();
  assert.equal(bg.dynamicScripts.size, 0);

  bg.setGrantedOrigins(['http://*/*', 'https://*/*', 'file:///*']);
  bg.listeners.permAdded.forEach((fn) => fn());
  await bg.syncAutoFormatScript();
  const reg = structuredClone(bg.dynamicScripts.get('json-toolbox-auto-format'));
  assert.deepEqual(reg.matches, ['http://*/*', 'https://*/*', 'file:///*']);
  assert.deepEqual(reg.js, ['content/detect.js']);
  assert.equal(reg.runAt, 'document_start');
  assert.equal(reg.allFrames, false);

  bg.setGrantedOrigins(['https://*/*']);
  bg.listeners.startup.forEach((fn) => fn());
  await bg.syncAutoFormatScript();
  assert.deepEqual(structuredClone(bg.dynamicScripts.get('json-toolbox-auto-format').matches), ['https://*/*']);

  bg.setGrantedOrigins([]);
  bg.listeners.permRemoved.forEach((fn) => fn());
  await bg.syncAutoFormatScript();
  assert.equal(bg.dynamicScripts.size, 0);
});

test('format-page-json context menu injects detect.js and sends FORMAT_PAGE_ON_DEMAND', async () => {
  const injected = [];
  const bg = setupBackground({
    async executeScript(opts) {
      injected.push(opts);
      return [];
    },
  });
  await bg.handleContextMenuClick({ menuItemId: 'format-page-json' }, { id: 55 });
  assert.deepEqual(structuredClone(injected), [{ target: { tabId: 55 }, files: ['content/detect.js'] }]);
  assert.deepEqual(structuredClone(bg.sentMessages), [{ tabId: 55, msg: { type: 'FORMAT_PAGE_ON_DEMAND' } }]);
});

test('prunes expired selection tokens, handles SYNC_AUTO_FORMAT and oversized OPEN_IN_FORMATTER cleanly', async () => {
  const bg = setupBackground();
  bg.sessionStore.set('selection:expired-old', { text: '{"stale":1}', normalized: false, createdAt: Date.now() - 10 * 60 * 1000 });
  bg.sessionStore.set('selection:fresh', { text: '{"fresh":1}', normalized: false, createdAt: Date.now() });

  await bg.handleContextMenuClick({ menuItemId: 'open-selection' }, { id: 1, index: 0 });
  assert.equal(bg.sessionStore.has('selection:expired-old'), false);
  assert.equal(bg.sessionStore.has('selection:fresh'), true);

  bg.setGrantedOrigins(['https://*/*']);
  const syncResp = await new Promise((resolve) => {
    const keepOpen = bg.listeners.messages[0]({ type: 'SYNC_AUTO_FORMAT' }, {}, resolve);
    assert.equal(keepOpen, true);
  });
  assert.deepEqual(structuredClone(syncResp), { ok: true });
  assert.deepEqual(structuredClone(bg.dynamicScripts.get('json-toolbox-auto-format').matches), ['https://*/*']);

  const tabsBefore = bg.openedTabs.length;
  const oversized = '"' + 'a'.repeat(10 * 1024 * 1024) + '"';
  const tooLargeResp = await new Promise((resolve) => {
    bg.listeners.messages[0]({ type: 'OPEN_IN_FORMATTER', text: oversized }, {}, resolve);
  });
  assert.deepEqual(structuredClone(tooLargeResp), { ok: false, reason: 'tooLarge' });
  assert.equal(bg.openedTabs.length, tabsBefore);
});
