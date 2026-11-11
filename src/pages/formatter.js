import { initializePage } from '../shared/page.js';
import { t } from '../shared/i18n.js';
import { createTaskRunner } from '../shared/worker-client.js';
import { createFeedback } from '../shared/feedback.js';
import { createFileImport } from '../shared/file-import.js';
import { createTextInput } from '../shared/text-input.js';
import { copyText } from '../shared/clipboard.js';
import { createVirtualTree } from '../shared/virtual-tree.js';
import { createVirtualTextView } from '../shared/virtual-text.js';

initializePage();

/* ================= DOM ================= */
const $ = (id) => document.getElementById(id);

const inputEl = $('input');
const textInput = createTextInput(inputEl, $('input-view'));
const outputTextEl = $('output-text');
const outputView = createVirtualTextView(outputTextEl);
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
  data: undefined,     // 最近一次解析出的对象（树视图/搜索用）
  numberLiterals: null, // 数字在原文中的字面量（path → 文本）
  dataSource: '',      // data 对应的原始文本，用于判断是否需要重新解析
  snapshotId: null,    // Worker 保存的同一份解析结果，切换树视图时按需取回
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

let dataVersion = 0;
let treeView = null;

const runTask = createTaskRunner({
  serialize: true,
  onBusyChange: (busy) => { busyEl.hidden = !busy; },
});

/* ================= 状态展示 ================= */
const { setStatus, showError, hideError, showParseError } = createFeedback({
  statusEl, errorEl, selectInputPosition: textInput.selectPosition,
});

const fileImport = createFileImport({
  dropZone: $('input-pane'),
  fileInput: $('file-input'),
  triggerEl: $('btn-import'),
  fileNameEl: $('file-name'),
  dropHint: $('file-drop-hint'),
  onImport: ({ text }) => {
    resetDocument();
    textInput.setText(text);
    if (textInput.isLarge()) {
      state.view = 'text';
      updateViewButtons();
    }
    void doFormat();
  },
  onError: showError,
});

/* ================= 视图切换 ================= */
function updateViewButtons() {
  $('view-text').classList.toggle('active', state.view === 'text');
  $('view-tree').classList.toggle('active', state.view === 'tree');
  outputTextEl.hidden = state.view !== 'text';
  treeEl.hidden = state.view !== 'tree';
  $('tree-tools').hidden = state.view !== 'tree';
  searchBox.hidden = state.view !== 'tree';
  levelBox.hidden = state.view !== 'tree';
}

function showText(text) {
  state.view = 'text';
  updateViewButtons();
  outputView.setText(text);
}

function currentText() {
  return state.outputText || textInput.getText();
}

// 树视图需要解析后的数据；若源文本没变则复用
async function ensureTreeData() {
  const text = currentText();
  if (!text.trim()) {
    showError(t('errNothingToParse'));
    return false;
  }
  if (state.data !== undefined && state.dataSource === text) return true;
  hideError();
  const version = dataVersion;
  const res = state.snapshotId !== null && text === state.outputText
    ? await runTask('parseSnapshot', { snapshotId: state.snapshotId })
    : await runTask('parse', { text, retainSnapshot: true });
  if (res.cancelled || version !== dataVersion || text !== currentText()) return false;
  if (!res.ok) {
    showParseError(text, res);
    return false;
  }
  state.data = res.result.data;
  state.numberLiterals = res.result.numberLiterals || null;
  state.dataSource = text;
  if (res.result.snapshotId !== undefined) state.snapshotId = res.result.snapshotId;
  return true;
}

async function setView(view) {
  if (view === state.view) return;
  if (view === 'tree') {
    if (!(await ensureTreeData())) return;
    state.view = 'tree';
    updateViewButtons();
    if (searchInput.value.trim()) runSearch();
    else renderTree();
  } else {
    showText(state.outputText);
  }
}

/* ================= 操作 ================= */
async function doFormat() {
  const text = textInput.getText();
  if (!text.trim()) {
    showError(t('errNeedInput'));
    return;
  }
  hideError();
  const version = ++dataVersion;
  const retainDocument = state.view === 'tree' || !textInput.isLarge();
  const res = await runTask('format', {
    text, indent: indentSel.value, includeData: state.view === 'tree',
    retainSnapshot: retainDocument, retainSearch: retainDocument,
  }, { key: 'format' });
  if (res.cancelled || version !== dataVersion) return;
  if (!res.ok) {
    showParseError(text, res);
    return;
  }
  treeView?.destroy();
  treeView = null;
  outputView.clear();
  state.outputText = res.result.text;
  state.snapshotId = res.result.snapshotId ?? null;
  state.data = res.result.data;
  state.numberLiterals = res.result.numberLiterals || null;
  state.dataSource = state.data === undefined ? '' : state.outputText;
  state.matchIndex = -1;
  if (state.view === 'tree') {
    if (state.data === undefined && !(await ensureTreeData())) return;
    if (version !== dataVersion) return;
    if (searchInput.value.trim()) runSearch();
    else renderTree();
  } else {
    showText(state.outputText);
  }
  setStatus(t('statusFormatted', [state.outputText.length.toLocaleString(), String(res.duration)]));
}

async function doCopy() {
  const text = state.outputText || textInput.getText();
  if (!text) {
    showError(t('errNothingToCopy'));
    return;
  }
  hideError();
  await copyText(text);
  setStatus(t('statusCopied', [text.length.toLocaleString()]));
}

function resetDocument() {
  dataVersion++;
  clearTimeout(searchTimer);
  searchTimer = 0;
  void runTask('clear', {}, { discardQueued: true });
  treeView?.destroy();
  treeView = null;
  textInput.clear();
  state.outputText = '';
  state.data = undefined;
  state.numberLiterals = null;
  state.dataSource = '';
  state.snapshotId = null;
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
  treeEl.innerHTML = '';
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
  const appName = t('appName');
  textInput.setText(JSON.stringify({
    name: appName === 'appName' ? 'JSON 工具箱' : appName,
    free: true,
    features: ['格式化', '压缩', '转义互转', '树形视图', '搜索', 'JSON 对比'],
    limits: { ads: 0, tracking: null },
    nested: Array.from({ length: 3 }, (_, i) => ({ id: i + 1, done: i % 2 === 0 })),
  }, null, 2));
  hideError();
  doFormat();
}

/* ================= 树形视图 ================= */
function renderTree() {
  const options = {
    data: state.data,
    numberLiterals: state.numberLiterals,
    expandLevel: state.expandLevel,
    expanded: state.expanded,
    collapsed: state.collapsed,
    forceExpand: state.searchForce,
    highlights: state.highlights,
  };
  if (treeView) treeView.update(options);
  else treeView = createVirtualTree(treeEl, options);
  if (state.searchQuery && state.matchCount > 0) updateMatchNav(0);
  else {
    treeView.setCurrent(null);
    updateMatchInfo();
  }
}

/* ================= 层级展开 ================= */
function applyLevel(value) {
  if (state.data === undefined || !value) return;
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
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 300);
}

async function runSearch() {
  const q = searchInput.value.trim();
  state.searchQuery = q;
  state.matchIndex = -1;
  if (state.data === undefined) {
    updateMatchInfo();
    return;
  }
  if (!q) {
    state.highlights = new Set();
    state.searchForce = new Set();
    state.matchCount = 0;
    state.matchTruncated = false;
    renderTree();
    return;
  }
  const version = dataVersion;
  const res = await runTask('search', { text: q }, { key: 'search' });
  if (res.cancelled || version !== dataVersion || searchInput.value.trim() !== q) return;
  if (!res.ok) {
    showError(t('errSearchFailed') + res.error);
    return;
  }
  state.highlights = new Set(res.result.highlights);
  state.searchForce = new Set(res.result.forceExpand);
  state.matchCount = res.result.matchCount;
  state.matchTruncated = res.result.truncated;
  renderTree();
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

inputEl.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    doFormat();
  }
});

$('input-view').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    doFormat();
  }
});

inputEl.addEventListener('input', () => fileImport.reset());
inputEl.addEventListener('paste', () => {
  if (autoFormatChk.checked) setTimeout(doFormat, 0);
});
