import { initializePage } from '../shared/page.js';
import { t } from '../shared/i18n.js';
import { hasNonWhitespace } from '../core/text-lines.js';
import { createDocumentSession } from '../shared/document-session.js';
import { createFeedback, createBusyFeedback, taskErrorMessage } from '../shared/feedback.js';
import { createFileImport } from '../shared/file-import.js';
import { createTextInput, LARGE_INPUT_THRESHOLD } from '../shared/text-input.js';
import { createRemoteTree } from '../shared/remote-tree.js';
import { createVirtualTree } from '../shared/virtual-tree.js';
import { createVirtualTextView } from '../shared/virtual-text.js';

initializePage();

/* ================= DOM ================= */
const $ = (id) => document.getElementById(id);

const inputEl = $('input');
const outputTextEl = $('output-text');
const treeEl = $('tree');
const statusEl = $('status');
const busyEl = $('busy');
const errorEl = $('error');
const indentSel = $('indent');
const autoFormatChk = $('auto-format');
const searchBox = $('search-box');
const searchInput = $('search');
const matchInfo = $('match-info');
const levelBox = $('level-box');
const levelSelect = $('level-select');

const state = {
  view: 'text',        // 'text' | 'tree'
  outputText: '',      // 最近一次操作产出的文本
  outputLineIndex: null,
  remote: false,      // 大文档只在 Worker 保存对象图，页面持有行窗口
  data: undefined,     // 小文档的解析对象；大文档对象图只保存在 Worker
  numberLiterals: null, // 数字在原文中的字面量（path → 文本）
  expanded: new Set(), // 用户手动展开的路径
  collapsed: new Set(), // 用户折叠优先于层级展开
  expandLevel: 1,      // 按需判断可见节点，不预先遍历整棵树
  searchForce: new Set(),  // 搜索命中需要强制展开的祖先路径
  highlights: new Set(),   // 搜索命中的路径
  matchCount: 0,
  matchTruncated: false,
  matchIndex: -1,
  searchQuery: '',
};

let pendingView = null;
let viewRequestVersion = 0;
let treeView = null;
let displayedDocument = null;
let treeDocument = null;

const session = createDocumentSession({
  onReset: invalidateViewRequest,
  onBusyChange: createBusyFeedback({
    busyEl, cancelEl: $('btn-cancel'),
    onCancel: () => { session.cancel(); invalidateViewRequest(); setStatus(t('statusCancelled')); },
  }),
});

/* ================= 状态展示 ================= */
const { setStatus, showError, hideError, showParseError, copyWithFeedback } = createFeedback({
  statusEl, errorEl, selectInputPosition: (position, line) => textInput.selectPosition(position, line),
});
const textInput = createTextInput(inputEl, $('input-editor'));
const outputView = createVirtualTextView(outputTextEl, { copy: copyWithFeedback });

const fileImport = createFileImport({
  dropZone: $('input-pane'),
  fileInput: $('file-input'),
  triggerEl: $('btn-import'),
  fileNameEl: $('file-name'),
  dropHint: $('file-drop-hint'),
  onImport: ({ text }) => {
    resetDocument();
    textInput.setText(text);
    if (text.length > LARGE_INPUT_THRESHOLD) {
      state.view = 'text';
      updateViewButtons();
      session.defer(() => { void doFormat(); });
    } else {
      void doFormat();
    }
  },
  onError: showError,
});

/* ================= 视图切换 ================= */
function invalidateViewRequest() {
  pendingView = null;
  viewRequestVersion++;
}

function updateViewButtons() {
  $('view-text').classList.toggle('active', state.view === 'text');
  $('view-tree').classList.toggle('active', state.view === 'tree');
  $('view-text').setAttribute('aria-pressed', String(state.view === 'text'));
  $('view-tree').setAttribute('aria-pressed', String(state.view === 'tree'));
  outputTextEl.hidden = state.view !== 'text';
  treeEl.hidden = state.view !== 'tree';
  $('tree-tools').hidden = state.view !== 'tree';
  searchBox.hidden = state.view !== 'tree';
  levelBox.hidden = state.view !== 'tree';
}

function showText(text) {
  state.view = 'text';
  updateViewButtons();
  outputView.setText(text, state.outputLineIndex);
}

async function showTree(requestVersion) {
  if (!treeView || !state.remote || treeDocument !== displayedDocument) renderTree(false);
  const candidate = treeView;
  if (candidate.ready && await candidate.ready === false) {
    if (candidate === treeView) destroyTree();
    return false;
  }
  if (requestVersion !== viewRequestVersion || candidate !== treeView) return false;
  state.view = 'tree';
  updateViewButtons();
  candidate.refresh();
  if (searchInput.value.trim()) runSearch();
  return true;
}

function currentText() {
  return state.outputText || textInput.getText();
}

// 树视图需要解析后的数据；若源文本没变则复用
async function ensureTreeData() {
  if (session.pending) return false;
  const text = currentText();
  if (!hasNonWhitespace(text)) {
    showError(t('errNothingToParse'));
    return false;
  }
  const remote = text.length > LARGE_INPUT_THRESHOLD;
  hideError();
  let applied = false;
  const res = await session.parse(text, { remote }, (res) => {
    applied = true;
    if (!res.ok) {
      showParseError(text, res);
      return;
    }
    displayedDocument = res.document;
    state.remote = displayedDocument.remote;
    state.data = displayedDocument.data;
    state.numberLiterals = displayedDocument.numberLiterals;
  });
  return applied && res.ok;
}

async function setView(view) {
  if (view === 'text' && state.view === 'text' && pendingView === 'tree') destroyTree();
  const requestVersion = ++viewRequestVersion;
  pendingView = view;
  // Keep the rendered view visible until its replacement is ready. A pending
  // choice is not a completed tree, and cancellation must leave it retryable.
  if (session.pending) return false;
  if (view === state.view && (view !== 'tree' || treeView)) {
    pendingView = null;
    return true;
  }
  if (view === 'tree') {
    const ready = await ensureTreeData();
    if (requestVersion !== viewRequestVersion) return false;
    const shown = ready && await showTree(requestVersion);
    if (requestVersion === viewRequestVersion) pendingView = null;
    return shown;
  } else {
    pendingView = null;
    showText(state.outputText);
  }
  return true;
}

/* ================= 操作 ================= */
async function doFormat() {
  const text = textInput.getText();
  if (!hasNonWhitespace(text)) {
    showError(t('errNeedInput'));
    return;
  }
  hideError();
  const large = text.length > LARGE_INPUT_THRESHOLD;
  let applied = false;
  let followup;
  const res = await session.format(text, { indent: indentSel.value, remote: large, tree: state.view === 'tree' }, (res) => {
    applied = true;
    if (!res.ok) {
      invalidateViewRequest();
      showParseError(text, res);
      return;
    }
    const nextView = pendingView ?? state.view;
    invalidateViewRequest();
    destroyTree();
    outputView.clear();
    state.outputText = res.result.text;
    state.outputLineIndex = res.result.lineIndex ?? null;
    displayedDocument = res.document;
    state.data = displayedDocument.data;
    state.numberLiterals = displayedDocument.numberLiterals;
    state.remote = displayedDocument.remote && displayedDocument.ready;
    state.matchIndex = -1;
    if (nextView === 'tree' && displayedDocument.ready && !state.remote) {
      followup = showTree(viewRequestVersion);
    } else {
      // Keep the formatted text usable during both parsing and the first
      // remote window request, including when formatting from the tree view.
      showText(state.outputText);
      if (nextView === 'tree') followup = setView('tree');
    }
  });
  if (!applied || !res.ok || (followup && !(await followup))) return;
  session.apply(res, () => setStatus(t('statusFormatted', [state.outputText.length.toLocaleString(), String(res.duration)])));
}

async function doCopy() {
  const text = state.outputText || textInput.getText();
  if (!text) {
    showError(t('errNothingToCopy'));
    return;
  }
  await copyWithFeedback(text);
}

function resetDocument() {
  invalidateViewRequest();
  clearTimeout(searchTimer);
  searchTimer = 0;
  session.clear();
  destroyTree();
  displayedDocument = null;
  textInput.clear();
  state.outputText = '';
  state.outputLineIndex = null;
  state.remote = false;
  state.data = undefined;
  state.numberLiterals = null;
  state.expanded.clear();
  state.collapsed.clear();
  state.expandLevel = 1;
  state.searchForce.clear();
  state.highlights.clear();
  state.matchCount = 0;
  state.matchTruncated = false;
  state.matchIndex = -1;
  state.searchQuery = '';
  searchInput.value = '';
  levelSelect.value = '';
  treeEl.replaceChildren();
  outputView.clear();
  hideError();
  setStatus('');
  updateMatchInfo();
  textInput.focus();
}

function doClear() {
  fileImport.reset();
  resetDocument();
}

function fillSample() {
  fileImport.reset();
  const label = (key, fallback) => {
    const value = t(key);
    return value === key ? fallback : value;
  };
  textInput.setText(JSON.stringify({
    name: label('appName', 'JSON Toolbox'),
    free: true,
    features: [
      label('navFormat', 'JSON Formatter'),
      label('navMinify', 'JSON Minify'),
      label('navEscape', 'JSON Escape'),
      label('viewTree', 'Tree'),
      label('navCompare', 'JSON Compare'),
    ],
    limits: { ads: 0, tracking: null },
    nested: Array.from({ length: 3 }, (_, i) => ({ id: i + 1, done: i % 2 === 0 })),
  }, null, 2));
  hideError();
  doFormat();
}

/* ================= 树形视图 ================= */
function destroyTree() {
  treeView?.destroy();
  treeView = null;
  treeDocument = null;
}

function renderTree(navigate = true) {
  const options = {
    data: state.data,
    numberLiterals: state.numberLiterals,
    expandLevel: state.expandLevel,
    expanded: state.expanded,
    collapsed: state.collapsed,
    forceExpand: state.searchForce,
    highlights: state.highlights,
  };
  if (treeView && (Boolean(treeDocument) !== state.remote || (treeDocument && treeDocument !== displayedDocument))) {
    destroyTree();
  }
  if (treeView) treeView.update(options);
  else if (state.remote) {
    treeDocument = displayedDocument;
    const document = treeDocument;
    const candidate = createRemoteTree(treeEl, { ...options, request: async (payload) => {
      const response = await document.requestTree(payload);
      if (treeView !== candidate) return { ok: false, cancelled: true };
      const applied = session.apply(response, () => {
        if (!response.ok && response.code !== 'TREE_MODEL_UNAVAILABLE') showError(taskErrorMessage(response));
      });
      return applied ? response : { ok: false, cancelled: true };
    } });
    treeView = candidate;
  } else treeView = createVirtualTree(treeEl, options);
  if (navigate && state.searchQuery && state.matchCount > 0) updateMatchNav(0);
  else {
    treeView.setCurrent(null);
    updateMatchInfo();
  }
}

/* ================= 层级展开 ================= */
function applyLevel(value) {
  if ((!state.remote && state.data === undefined) || !value) return;
  const level = value === 'all' ? Infinity : Number(value);
  state.expandLevel = level;
  state.expanded.clear();
  state.collapsed.clear();
  renderTree();
  setStatus(level === Infinity ? t('expandedAll') : t('expandedLevel', [String(level)]));
}

/* ================= 搜索 ================= */
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
  // A queued parse of the displayed old document would overwrite the new
  // format's Worker cache. doFormat searches the current query once it settles.
  if (session.pending) return;
  if (!state.remote && state.data === undefined) {
    updateMatchInfo();
    return;
  }
  if (!q) {
    session.invalidateSearch();
    state.highlights = new Set();
    state.searchForce = new Set();
    state.matchCount = 0;
    state.matchTruncated = false;
    renderTree();
    return;
  }
  const res = await displayedDocument.search(q);
  session.apply(res, () => {
    if (!res.ok) {
      showError(t('errSearchFailed') + taskErrorMessage(res));
      return;
    }
    state.highlights = new Set(res.result.highlights);
    state.searchForce = new Set(res.result.forceExpand);
    state.matchCount = res.result.matchCount;
    state.matchTruncated = res.result.truncated;
    renderTree();
  });
}

function updateMatchNav(index) {
  const paths = [...state.highlights];
  if (!paths.length || !treeView) {
    state.matchIndex = -1;
    updateMatchInfo();
    return;
  }
  state.matchIndex = ((index % paths.length) + paths.length) % paths.length;
  const path = paths[state.matchIndex];
  treeView.reveal(path);
  treeView.setCurrent(path);
  updateMatchInfo();
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

/* ================= 事件绑定 ================= */
$('btn-format').addEventListener('click', doFormat);
$('btn-copy').addEventListener('click', doCopy);
$('btn-clear').addEventListener('click', doClear);
$('btn-sample').addEventListener('click', fillSample);
$('view-text').addEventListener('click', () => setView('text'));
$('view-tree').addEventListener('click', () => setView('tree'));
$('match-prev').addEventListener('click', () => updateMatchNav(state.matchIndex - 1));
$('match-next').addEventListener('click', () => updateMatchNav(state.matchIndex + 1));

levelSelect.addEventListener('change', () => {
  applyLevel(levelSelect.value);
  levelSelect.value = ''; // 当作动作菜单用，选完复位到占位项
});

searchInput.addEventListener('input', scheduleSearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    updateMatchNav(state.matchIndex + (e.shiftKey ? -1 : 1));
  }
});

textInput.bindEvents({
  onChange() {
    fileImport.reset();
    invalidateViewRequest();
    session.cancel({ onlyIfBusy: true });
  },
  onRun: doFormat,
  afterTransfer() {
    if (autoFormatChk.checked) session.defer(() => { void doFormat(); });
  },
});
