'use strict';

const MENU_OPEN_SELECTION = 'open-selection';
const MENU_FORMAT_PAGE = 'format-page-json';
const SESSION_SELECTION_PREFIX = 'selection:';
// chrome.storage.session total quota is 10 MiB; stay safely below quota with key + JSON wrapper.
const MAX_SESSION_BYTES = 10 * 1024 * 1024;
const AUTO_FORMAT_SCRIPT_ID = 'json-toolbox-auto-format';
const AUTO_FORMAT_ORIGINS = ['http://*/*', 'https://*/*', 'file:///*'];
const utf8Encoder = new TextEncoder();

function i18nMessage(key, fallback) {
  try {
    return chrome.i18n?.getMessage?.(key) || fallback;
  } catch {
    return fallback;
  }
}

function createToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createTabOptions(url, openerTab) {
  const options = { url };
  if (openerTab && typeof openerTab.id === 'number') {
    options.openerTabId = openerTab.id;
    if (typeof openerTab.index === 'number') {
      options.index = openerTab.index + 1;
    }
  }
  return options;
}

function ensureContextMenus() {
  if (!chrome.contextMenus?.create) return;
  const createAll = () => {
    chrome.contextMenus.create({
      id: MENU_OPEN_SELECTION,
      title: i18nMessage('menuOpenSelection', 'Open selection in JSON Toolbox'),
      contexts: ['selection'],
    }, () => { void chrome.runtime?.lastError; });
    chrome.contextMenus.create({
      id: MENU_FORMAT_PAGE,
      title: i18nMessage('menuFormatPage', 'Format JSON on this page'),
      contexts: ['page'],
    }, () => { void chrome.runtime?.lastError; });
  };
  if (typeof chrome.contextMenus.removeAll === 'function') {
    chrome.contextMenus.removeAll(createAll);
  } else {
    createAll();
  }
}

async function getGrantedAutoFormatOrigins() {
  if (!chrome.permissions) return [];
  if (typeof chrome.permissions.getAll === 'function') {
    const all = await chrome.permissions.getAll();
    const granted = new Set(all?.origins || []);
    return AUTO_FORMAT_ORIGINS.filter((origin) => granted.has(origin));
  }
  if (typeof chrome.permissions.contains === 'function') {
    const matched = [];
    for (const origin of AUTO_FORMAT_ORIGINS) {
      if (await chrome.permissions.contains({ origins: [origin] })) matched.push(origin);
    }
    return matched;
  }
  return [];
}

let syncChain = Promise.resolve();

function syncAutoFormatScript() {
  syncChain = syncChain.then(async () => {
    if (!chrome.scripting?.registerContentScripts) return false;
    const matches = await getGrantedAutoFormatOrigins();
    if (matches.length > 0) {
      const spec = {
        id: AUTO_FORMAT_SCRIPT_ID,
        matches,
        js: ['content/detect.js'],
        runAt: 'document_start',
        allFrames: false,
        persistAcrossSessions: true,
      };
      const existing = typeof chrome.scripting.getRegisteredContentScripts === 'function'
        ? await chrome.scripting.getRegisteredContentScripts({ ids: [AUTO_FORMAT_SCRIPT_ID] })
        : [];
      if (existing.length > 0 && typeof chrome.scripting.updateContentScripts === 'function') {
        await chrome.scripting.updateContentScripts([spec]);
      } else {
        try {
          await chrome.scripting.registerContentScripts([spec]);
        } catch {
          if (typeof chrome.scripting.updateContentScripts === 'function') {
            await chrome.scripting.updateContentScripts([spec]);
          }
        }
      }
      return true;
    }
    if (typeof chrome.scripting.unregisterContentScripts === 'function') {
      try {
        await chrome.scripting.unregisterContentScripts({ ids: [AUTO_FORMAT_SCRIPT_ID] });
      } catch {
        // Ignore when no dynamic script was previously registered.
      }
    }
    return false;
  }, () => false);
  return syncChain;
}

/*
 * Executed inside the active tab via activeTab + scripting.
 * Note on info.selectionText fallback: Chrome normalizes whitespace in
 * contextMenus OnClickData.selectionText (collapsing line breaks and tabs to
 * spaces, trimming edges) and cannot always read <textarea>/<input> selections
 * cleanly, and very long selections may be truncated by browser IPC. Prefer
 * executeScript so newlines/whitespace and <textarea> selections stay exact.
 */
function readActiveSelectionInPage() {
  const active = document.activeElement;
  if (active && typeof active.selectionStart === 'number' && typeof active.selectionEnd === 'number') {
    const tag = active.tagName;
    if (tag === 'TEXTAREA' || (tag === 'INPUT' && (!active.type || /^(text|search|url|tel|password)$/i.test(active.type)))) {
      const selected = active.value.slice(active.selectionStart, active.selectionEnd);
      if (selected) return selected;
    }
  }
  return window.getSelection ? window.getSelection().toString() : '';
}

async function readSelection(tab, info) {
  if (typeof tab?.id === 'number' && tab.id >= 0 && chrome.scripting?.executeScript) {
    try {
      const target = typeof info?.frameId === 'number'
        ? { tabId: tab.id, frameIds: [info.frameId] }
        : { tabId: tab.id };
      const results = await chrome.scripting.executeScript({
        target,
        func: readActiveSelectionInPage,
      });
      const text = results?.[0]?.result;
      if (typeof text === 'string' && text.length > 0) {
        return { text, normalized: false };
      }
    } catch {
      // Restricted pages (chrome://, Chrome Web Store, PDF viewer) disallow script injection.
    }
  }
  if (typeof info?.selectionText === 'string' && info.selectionText.length > 0) {
    return { text: info.selectionText, normalized: true };
  }
  return null;
}

async function openFormatterWithText(text, { normalized = false, openerTab = null } = {}) {
  const token = createToken();
  const key = SESSION_SELECTION_PREFIX + token;
  const payload = { text, normalized };
  const estimatedBytes = utf8Encoder.encode(key + JSON.stringify(payload)).length;
  const tooLargeUrl = chrome.runtime.getURL('formatter.html?importError=tooLarge');

  if (estimatedBytes > MAX_SESSION_BYTES) {
    await chrome.tabs.create(createTabOptions(tooLargeUrl, openerTab));
    return { ok: false, reason: 'tooLarge' };
  }

  try {
    await chrome.storage.session.set({ [key]: payload });
  } catch {
    await chrome.tabs.create(createTabOptions(tooLargeUrl, openerTab));
    return { ok: false, reason: 'tooLarge' };
  }

  const url = chrome.runtime.getURL(`formatter.html?import=${encodeURIComponent(token)}`);
  await chrome.tabs.create(createTabOptions(url, openerTab));
  return { ok: true, token, normalized };
}

async function formatPageOnDemand(tab) {
  if (typeof tab?.id !== 'number' || tab.id < 0 || !chrome.scripting?.executeScript) return null;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/detect.js'],
    });
    return await chrome.tabs.sendMessage(tab.id, { type: 'FORMAT_PAGE_ON_DEMAND' });
  } catch {
    return { ok: false, reason: 'restricted' };
  }
}

async function handleContextMenuClick(info, tab) {
  if (info?.menuItemId === MENU_OPEN_SELECTION) {
    const selection = await readSelection(tab, info);
    if (!selection) return null;
    return openFormatterWithText(selection.text, {
      normalized: selection.normalized,
      openerTab: tab,
    });
  }
  if (info?.menuItemId === MENU_FORMAT_PAGE) {
    return formatPageOnDemand(tab);
  }
  return null;
}

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('formatter.html') });
});

chrome.runtime.onInstalled?.addListener(() => {
  ensureContextMenus();
  void syncAutoFormatScript();
});

chrome.runtime.onStartup?.addListener(() => {
  void syncAutoFormatScript();
});

chrome.permissions?.onAdded?.addListener(() => {
  void syncAutoFormatScript();
});

chrome.permissions?.onRemoved?.addListener(() => {
  void syncAutoFormatScript();
});

chrome.contextMenus?.onClicked?.addListener((info, tab) => {
  void handleContextMenuClick(info, tab);
});

chrome.runtime.onMessage?.addListener((message, sender, sendResponse) => {
  if (message?.type === 'OPEN_IN_FORMATTER' && typeof message.text === 'string') {
    openFormatterWithText(message.text, {
      normalized: false,
      openerTab: sender?.tab ?? null,
    }).then((result) => sendResponse(result), () => sendResponse({ ok: false }));
    return true;
  }
  return false;
});
