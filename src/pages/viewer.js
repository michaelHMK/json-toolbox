import { applyI18n, t } from '../shared/i18n.js';
import { createDocumentSession } from '../shared/document-session.js';
import { createFeedback, createBusyFeedback, taskErrorMessage } from '../shared/feedback.js';
import { createVirtualTree } from '../shared/virtual-tree.js';
import { createVirtualTextView } from '../shared/virtual-text.js';

applyI18n();

const $ = (id) => document.getElementById(id);

const urlEl = $('viewer-url');
const outputTextEl = $('output-text');
const treeEl = $('tree');
const statusEl = $('status');
const busyEl = $('busy');
const errorEl = $('error');
const treeToolsEl = $('tree-tools');
const searchInput = $('search');
const matchInfo = $('match-info');
const levelSelect = $('level-select');

const LARGE_VIEW_THRESHOLD = 256 * 1024;
const utf8Decoder = new TextDecoder('utf-8');

const state = {
  view: 'tree',
  rawText: '',
  rawLineIndex: null,
  expanded: new Set(),
  collapsed: new Set(),
  expandLevel: 2,
  searchForce: new Set(),
  highlights: new Set(),
  matchCount: 0,
  matchTruncated: false,
  matchIndex: -1,
  searchQuery: '',
};

let treeView = null;
let displayedDocument = null;
let treeDocument = null;
let viewRequestVersion = 0;
let initialized = false;

const session = createDocumentSession({
  onReset: () => { viewRequestVersion++; },
  onBusyChange: createBusyFeedback({
    busyEl,
    cancelEl: $('btn-cancel'),
    onCancel: () => { session.cancel(); viewRequestVersion++; setStatus(t('statusCancelled')); },
  }),
});

const { setStatus, showError, hideError, copyWithFeedback } = createFeedback({
  statusEl,
  errorEl,
});
const outputView = createVirtualTextView(outputTextEl, { copy: copyWithFeedback });

function setDisplayedUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return;
  if (/^(?:https?|file):/i.test(rawUrl)) {
    urlEl.textContent = rawUrl;
    urlEl.title = rawUrl;
  }
}

function updateViewButtons() {
  const isTree = state.view === 'tree';
  $('view-tree').classList.toggle('active', isTree);
  $('view-text').classList.toggle('active', !isTree);
  $('view-tree').setAttribute('aria-pressed', String(isTree));
  $('view-text').setAttribute('aria-pressed', String(!isTree));
  treeEl.hidden = !isTree;
  treeToolsEl.hidden = !isTree;
  outputTextEl.hidden = isTree;
}

function destroyTree() {
  treeView?.destroy();
  treeView = null;
  treeDocument = null;
}

function renderTree(navigate = true) {
  if (!displayedDocument) return Promise.resolve(false);
  const options = {
    expandLevel: state.expandLevel,
    expanded: state.expanded,
    collapsed: state.collapsed,
    forceExpand: state.searchForce,
    highlights: state.highlights,
  };
  if (treeView && treeDocument !== displayedDocument) destroyTree();
  let pending;
  if (treeView) {
    pending = treeView.update(options);
  } else {
    treeDocument = displayedDocument;
    const documentHandle = treeDocument;
    const candidate = createVirtualTree(treeEl, {
      ...options,
      request: async (payload) => {
        const response = await documentHandle.requestTree(payload);
        if (treeView !== candidate) return { ok: false, cancelled: true };
        const applied = session.apply(response, () => {
          if (!response.ok && response.code !== 'TREE_MODEL_UNAVAILABLE') showError(taskErrorMessage(response));
        });
        return applied ? response : { ok: false, cancelled: true };
      },
    });
    treeView = candidate;
    pending = candidate.ready;
  }
  if (navigate && state.searchQuery && state.matchCount > 0) return updateMatchNav(0);
  treeView.setCurrent(null);
  updateMatchInfo();
  return pending;
}

async function showTree(requestVersion) {
  if (!treeView || treeDocument !== displayedDocument) renderTree(false);
  const candidate = treeView;
  if (!candidate || await candidate.ready === false) {
    if (candidate && candidate === treeView) destroyTree();
    return false;
  }
  if (requestVersion !== viewRequestVersion || candidate !== treeView) return false;
  state.view = 'tree';
  updateViewButtons();
  candidate.refresh();
  if (searchInput.value.trim()) void runSearch();
  return true;
}

function setView(view) {
  state.view = view;
  updateViewButtons();
  if (view === 'text') {
    if (state.rawText) outputView.setText(state.rawText, state.rawLineIndex);
    else outputView.clear();
    return;
  }
  if (displayedDocument) {
    const version = ++viewRequestVersion;
    void showTree(version);
  }
}

function applyLevel(value) {
  if (!displayedDocument?.ready || !value) return Promise.resolve(false);
  const level = value === 'all' ? Infinity : Number(value);
  state.expandLevel = level;
  state.expanded.clear();
  state.collapsed.clear();
  const pending = renderTree();
  setStatus(level === Infinity ? t('expandedAll') : t('expandedLevel', [String(level)]));
  return pending;
}

let searchTimer = 0;

function scheduleSearch() {
  session.invalidateSearch();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 300);
}

async function runSearch() {
  const q = searchInput.value.trim();
  state.searchQuery = q;
  state.matchIndex = -1;
  if (session.pending || !displayedDocument?.ready) {
    updateMatchInfo();
    return;
  }
  if (!q) {
    session.invalidateSearch();
    state.highlights = new Set();
    state.searchForce = new Set();
    state.matchCount = 0;
    state.matchTruncated = false;
    await renderTree();
    return;
  }
  const res = await displayedDocument.search(q);
  let rendered;
  session.apply(res, () => {
    if (!res.ok) {
      showError(t('errSearchFailed') + taskErrorMessage(res));
      return;
    }
    state.highlights = new Set(res.result.highlights);
    state.searchForce = new Set(res.result.forceExpand);
    state.matchCount = res.result.matchCount;
    state.matchTruncated = res.result.truncated;
    rendered = renderTree();
  });
  if (rendered) await rendered;
}

function updateMatchNav(index) {
  const paths = [...state.highlights];
  if (!paths.length || !treeView) {
    state.matchIndex = -1;
    updateMatchInfo();
    return Promise.resolve(false);
  }
  state.matchIndex = ((index % paths.length) + paths.length) % paths.length;
  const path = paths[state.matchIndex];
  const pending = treeView.reveal(path);
  treeView.setCurrent(path);
  updateMatchInfo();
  return pending;
}

function updateMatchInfo() {
  if (!state.searchQuery) {
    matchInfo.textContent = '';
    return;
  }
  if (state.matchCount === 0) {
    matchInfo.textContent = t('matchNone');
    return;
  }
  const total = state.matchCount + (state.matchTruncated ? '+' : '');
  matchInfo.textContent = `${Math.max(state.matchIndex, 0) + 1} / ${total}`;
}

async function loadDocument(text, port = null) {
  const started = Date.now();
  hideError();
  destroyTree();
  outputView.clear();
  state.rawText = text;
  state.rawLineIndex = null;
  state.expanded.clear();
  state.collapsed.clear();
  state.expandLevel = text.length > LARGE_VIEW_THRESHOLD ? 1 : 2;
  state.searchForce.clear();
  state.highlights.clear();
  state.matchCount = 0;
  state.matchTruncated = false;
  state.matchIndex = -1;
  state.searchQuery = '';
  searchInput.value = '';
  levelSelect.value = '';
  const version = ++viewRequestVersion;

  const res = await session.parse(text, (response) => {
    if (!response.ok) {
      port?.postMessage({ type: 'PARSE_ERROR', error: response.error });
      showError(taskErrorMessage(response));
      return;
    }
    displayedDocument = response.document;
    state.rawLineIndex = response.result.lineIndex ?? null;
  }, { strict: true, includeTextIndex: true });

  if (!res.ok || res.cancelled) return;
  const shown = await showTree(version);
  if (!shown) {
    port?.postMessage({ type: 'PARSE_ERROR', error: 'Failed to display JSON tree' });
    return;
  }
  setStatus(t('statusViewerReady', [text.length.toLocaleString(), String(Date.now() - started)]));
  port?.postMessage({ type: 'READY' });
}

$('view-tree').addEventListener('click', () => setView('tree'));
$('view-text').addEventListener('click', () => setView('text'));
$('btn-copy').addEventListener('click', async () => {
  if (!state.rawText) {
    showError(t('errNothingToCopy'));
    return;
  }
  await copyWithFeedback(state.rawText);
});
$('btn-open-toolbox').addEventListener('click', async () => {
  if (!state.rawText) return;
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'OPEN_IN_FORMATTER', text: state.rawText });
      if (response && !response.ok && response.reason === 'tooLarge') {
        showError(t('errTransferTooLarge'));
      }
    } catch {
      showError(t('errTaskFailed'));
    }
  }
});
$('match-prev').addEventListener('click', () => updateMatchNav(state.matchIndex - 1));
$('match-next').addEventListener('click', () => updateMatchNav(state.matchIndex + 1));
levelSelect.addEventListener('change', () => {
  void applyLevel(levelSelect.value);
  levelSelect.value = '';
});
searchInput.addEventListener('input', scheduleSearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void updateMatchNav(state.matchIndex + (e.shiftKey ? -1 : 1));
  }
});

if (typeof location !== 'undefined' && location.search) {
  const params = new URLSearchParams(location.search);
  setDisplayedUrl(params.get('url'));
}

window.addEventListener('message', (event) => {
  if (window.parent !== window && event.source !== window.parent) return;
  if (initialized || event.data?.type !== 'INIT') return;
  const port = event.ports?.[0] || null;
  if (!port) return;
  if (!(event.data.buffer instanceof ArrayBuffer)) {
    port.postMessage({ type: 'PARSE_ERROR', error: 'Invalid buffer' });
    return;
  }
  initialized = true;
  port.postMessage({ type: 'ACK' });
  if (event.data.url) setDisplayedUrl(event.data.url);
  const text = utf8Decoder.decode(event.data.buffer);
  void loadDocument(text, port);
});
