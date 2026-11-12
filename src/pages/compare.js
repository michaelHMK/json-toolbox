import { initializePage } from '../shared/page.js';
import { t } from '../shared/i18n.js';
import { createTaskRunner } from '../shared/worker-client.js';
import { createFeedback, createBusyFeedback, taskErrorMessage } from '../shared/feedback.js';
import { createChildPathIndex } from '../shared/json-tree.js';
import { createVirtualTree } from '../shared/virtual-tree.js';
import { createVirtualTextView } from '../shared/virtual-text.js';

initializePage();

/* ================= DOM ================= */
const $ = (id) => document.getElementById(id);

const inputLeft = $('input-left');
const inputRight = $('input-right');
const errorEl = $('error');
const statusEl = $('status');
const busyEl = $('busy');
const resultEl = $('result');
const structView = $('struct-view');
const textView = $('text-view');
const textRenderer = createVirtualTextView(textView);
const treeLeftEl = $('tree-left');
const treeRightEl = $('tree-right');
const arrayModeSel = $('array-mode');
const keyFieldBox = $('key-field-box');
const keyFieldInput = $('key-field');
const ignoreInput = $('ignore-paths');
const onlyDiffChk = $('only-diff');
const diffNavEl = $('diff-nav');
const diffInfoEl = $('diff-info');


const state = {
  view: 'struct',      // 'struct' | 'text'
  result: null,        // 结构 diff 结果
  textResult: null,    // 文本 diff 结果（每次对比后失效重算）
  treesDirty: true,
  indexesReady: false,
  leftText: '',
  rightText: '',
  children: { left: new Map(), right: new Map() },
  leftData: undefined,
  rightData: undefined,
  leftNumberLiterals: null,
  rightNumberLiterals: null,
  onlyDiff: false,
  diffIndex: -1,
  expanded: { left: new Set(), right: new Set() },     // 用户手动展开
  collapsed: { left: new Set(), right: new Set() },
  force: { left: new Set(), right: new Set() },        // 差异祖先，自动展开
  diffMap: { left: new Map(), right: new Map() },      // path → diff 记录
  pairLR: new Map(),   // 主键配对导致的左路径 → 右路径
  pairRL: new Map(),
};

const treeViews = { left: null, right: null };
let dataVersion = 0;
let comparingVersion = null;
let textRequest = null;
let dataRequest = null;

const runTask = createTaskRunner({
  serialize: true,
  onReset: () => {
    if (state.result) delete state.result.snapshotId;
    textRequest = null;
    dataRequest = null;
    comparingVersion = null;
  },
  onBusyChange: createBusyFeedback({
    busyEl, cancelEl: $('btn-cancel'),
    onCancel: () => { dataVersion++; runTask.cancel(); setStatus(t('statusCancelled')); },
  }),
});

/* ================= 状态展示 ================= */
const { setStatus, showError, hideError, showParseError } = createFeedback({
  statusEl, errorEl,
  selectInputPosition: (position, _line, side) => {
    const input = side === 'right' ? inputRight : inputLeft;
    input.focus();
    input.setSelectionRange(position, position);
  },
});

/* ================= 对比主流程 ================= */
async function doCompare() {
  const lt = inputLeft.value;
  const rt = inputRight.value;
  if (!lt.trim() || !rt.trim()) {
    showError(t('errNeedBothSides'));
    return;
  }
  hideError();
  runTask.cancel({ onlyIfBusy: true });
  const version = ++dataVersion;
  comparingVersion = version;
  textRequest = null;
  dataRequest = null;
  const ignorePaths = ignoreInput.value
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const keyField = arrayModeSel.value === 'key' ? keyFieldInput.value.trim() : '';
  const res = await runTask('diff', {
    text: lt, text2: rt, keyField, ignorePaths,
    includeData: state.view === 'struct', retainSnapshot: true,
  }, { key: 'diff' });
  if (comparingVersion === version) comparingVersion = null;
  if (res.cancelled || version !== dataVersion) return;
  if (!res.ok) {
    showParseError(res.side === 'right' ? rt : lt, res, 'errCompareFailed');
    return;
  }
  state.result = res.result;
  state.leftText = lt;
  state.rightText = rt;
  textRequest = null;
  state.textResult = null; // 输入变了，文本 diff 需重算
  state.treesDirty = true;
  // 文本模式也释放上一轮结构视图，避免隐藏 DOM 的闭包保留旧数据。
  treeLeftEl.innerHTML = '';
  treeRightEl.innerHTML = '';
  textRenderer.clear();
  destroyTrees();
  clearIndexes();
  state.leftData = res.result.leftData;
  state.rightData = res.result.rightData;
  state.leftNumberLiterals = res.result.leftNumberLiterals || null;
  state.rightNumberLiterals = res.result.rightNumberLiterals || null;
  state.diffIndex = -1;
  resultEl.hidden = false;
  if (state.view === 'text') {
    if (!(await loadTextDiff())) return;
    if (version !== dataVersion) return;
  } else {
    if (!(await ensureComparisonData())) return;
    if (version !== dataVersion) return;
    refreshTrees();
  }
  updateStatus();
}

async function ensureComparisonData() {
  if (comparingVersion !== null) return false;
  if (state.leftData !== undefined) return true;
  const comparison = state.result;
  if (!comparison) return false;
  const version = dataVersion;
  dataRequest ||= comparison.snapshotId !== undefined
    ? runTask('comparisonData', { snapshotId: comparison.snapshotId })
    : runTask('diff', { text: state.leftText, text2: state.rightText, retainSnapshot: true });
  const res = await dataRequest;
  if (res.cancelled || version !== dataVersion || comparison !== state.result) return false;
  dataRequest = null;
  if (!res.ok) {
    showError(t('errCompareFailed') + taskErrorMessage(res));
    return false;
  }
  for (const key of ['leftData', 'rightData', 'leftNumberLiterals', 'rightNumberLiterals', 'snapshotId']) {
    if (res.result[key] !== undefined) comparison[key] = res.result[key];
  }
  state.leftData = res.result.leftData;
  state.rightData = res.result.rightData;
  state.leftNumberLiterals = res.result.leftNumberLiterals;
  state.rightNumberLiterals = res.result.rightNumberLiterals;
  return true;
}

function clearIndexes() {
  state.indexesReady = false;
  for (const side of ['left', 'right']) {
    state.diffMap[side].clear();
    state.force[side].clear();
    state.expanded[side].clear();
    state.collapsed[side].clear();
    state.children[side].clear();
  }
  state.pairLR.clear();
  state.pairRL.clear();
}

function buildIndexes() {
  const r = state.result;
  state.pairLR = new Map(r.pairs);
  state.pairRL = new Map(r.pairs.map(([l, rr]) => [rr, l]));
  for (const d of r.diffs) {
    if (d.leftPath !== null) state.diffMap.left.set(d.leftPath, d);
    if (d.rightPath !== null) state.diffMap.right.set(d.rightPath, d);
  }
  for (const side of ['left', 'right']) {
    state.children[side] = createChildPathIndex(state.diffMap[side].keys());
    state.force[side] = new Set(state.children[side].keys());
  }
  state.indexesReady = true;
}

function updateStatus() {
  if (!state.result) return;
  const s = state.result.stats;
  let text = t('diffStats', [
    String(state.result.total),
    String(s.added),
    String(s.removed),
    String(s.changed),
    String(s.typeChanged),
  ]);
  if (state.result.truncated) text += t('diffStatsTruncated', [String(state.result.diffs.length)]);
  if (state.result.keyFallback) text += t('diffKeyFallback');
  if (state.result.total === 0) text += t('diffIdenticalNote');
  setStatus(text);
}

/* ================= 双树渲染 ================= */
function refreshTrees() {
  renderTrees();
  if (state.result && state.result.diffs.length) goToDiff(0);
  else updateDiffInfo();
}

function destroyTrees() {
  for (const side of ['left', 'right']) {
    treeViews[side]?.destroy();
    treeViews[side] = null;
  }
}

function pairedPath(side, path) {
  const pairs = side === 'left' ? state.pairLR : state.pairRL;
  let ancestor = path;
  while (ancestor !== '') {
    const paired = pairs.get(ancestor);
    if (paired !== undefined) return paired + path.slice(ancestor.length);
    ancestor = ancestor.slice(0, ancestor.lastIndexOf('/'));
  }
  return path;
}

function renderTrees() {
  if (!state.indexesReady) buildIndexes();
  state.treesDirty = false;
  for (const side of ['left', 'right']) {
    const options = {
      data: side === 'left' ? state.leftData : state.rightData,
      numberLiterals: side === 'left' ? state.leftNumberLiterals : state.rightNumberLiterals,
      expanded: state.expanded[side],
      collapsed: state.collapsed[side],
      forceExpand: state.force[side],
      requiredChildren: state.children[side],
      onlyRequired: state.onlyDiff,
      decorations: state.diffMap[side],
      onToggle(path, open) {
        suspendScrollSync();
        const other = side === 'left' ? 'right' : 'left';
        treeViews[other]?.setOpen(pairedPath(side, path), open);
      },
    };
    if (treeViews[side]) treeViews[side].update(options);
    else treeViews[side] = createVirtualTree(side === 'left' ? treeLeftEl : treeRightEl, options);
  }
}

/* ================= 差异导航 ================= */
function goToDiff(i) {
  const diffs = state.result ? state.result.diffs : [];
  if (!diffs.length) {
    state.diffIndex = -1;
    updateDiffInfo();
    return;
  }
  state.diffIndex = ((i % diffs.length) + diffs.length) % diffs.length;
  const diff = diffs[state.diffIndex];
  // 配对后的两侧行号可能相距很远；本次导航各自定位，避免 scroll 事件互相覆盖。
  suspendScrollSync();
  for (const side of ['left', 'right']) {
    const path = side === 'left' ? diff.leftPath : diff.rightPath;
    if (path !== null) treeViews[side]?.reveal(path);
    treeViews[side]?.setCurrent(path);
  }
  updateDiffInfo();
}

function updateDiffInfo() {
  const total = state.result ? state.result.total : 0;
  if (!total) {
    diffInfoEl.textContent = '';
    return;
  }
  const shown = state.result.diffs.length;
  diffInfoEl.textContent = `${state.diffIndex + 1} / ${shown}${state.result.truncated ? '+' : ''}`;
}

/* ================= 文本 diff 视图 ================= */
async function loadTextDiff() {
  if (comparingVersion !== null) return false;
  const version = dataVersion;
  const comparison = state.result;
  if (!state.textResult) {
    textRequest ||= runTask('textDiff', {
      ...(comparison.snapshotId === undefined
        ? { text: state.leftText, text2: state.rightText }
        : { snapshotId: comparison.snapshotId }),
      indent: '2',
    });
    const res = await textRequest;
    if (res.cancelled || version !== dataVersion || comparison !== state.result) return false;
    textRequest = null;
    if (!res.ok) {
      showError(t('errTextDiffFailed') + taskErrorMessage(res));
      return false;
    }
    state.textResult = res.result;
  }
  renderTextDiff();
  return true;
}

function renderTextDiff() {
  textRenderer.setDiff(state.textResult);
}

/* ================= 视图切换 ================= */
async function setCompareView(view) {
  state.view = view;
  $('view-struct').classList.toggle('active', view === 'struct');
  $('view-text').classList.toggle('active', view === 'text');
  structView.hidden = view !== 'struct';
  textView.hidden = view !== 'text';
  diffNavEl.style.visibility = view === 'struct' ? '' : 'hidden';
  if (!state.result || comparingVersion !== null) return;
  if (view === 'text') await loadTextDiff();
  else if (state.treesDirty && await ensureComparisonData() && state.view === 'struct') refreshTrees();
  else if (state.view === 'struct') {
    treeViews.left?.refresh();
    treeViews.right?.refresh();
  }
}

/* ================= 其他操作 ================= */
function doSwap() {
  dataVersion++;
  runTask.cancel({ onlyIfBusy: true });
  const t2 = inputLeft.value;
  inputLeft.value = inputRight.value;
  inputRight.value = t2;
  if (state.result) doCompare();
}

function doClear() {
  dataVersion++;
  comparingVersion = null;
  textRequest = null;
  dataRequest = null;
  void runTask('clear', {}, { discardQueued: true });
  destroyTrees();
  state.leftText = '';
  state.rightText = '';
  clearIndexes();
  inputLeft.value = '';
  inputRight.value = '';
  state.result = null;
  state.treesDirty = true;
  state.textResult = null;
  state.leftData = undefined;
  state.rightData = undefined;
  state.leftNumberLiterals = null;
  state.rightNumberLiterals = null;
  state.diffIndex = -1;
  resultEl.hidden = true;
  treeLeftEl.innerHTML = '';
  treeRightEl.innerHTML = '';
  textRenderer.clear();
  hideError();
  setStatus('');
  updateDiffInfo();
  inputLeft.focus();
}

function fillSample() {
  inputLeft.value = JSON.stringify({
    version: 1,
    users: [
      { id: 1, name: '甲', role: 'admin' },
      { id: 2, name: '乙', role: 'user' },
    ],
    updatedAt: '2026-08-01',
  }, null, 2);
  inputRight.value = JSON.stringify({
    version: 2,
    users: [
      { id: 2, name: '乙', role: 'admin' },
      { id: 3, name: '丙', role: 'user' },
    ],
    updatedAt: '2026-08-24',
  }, null, 2);
  hideError();
  doCompare();
}

/* ================= 滚动同步 ================= */
let scrollSyncing = false;
let scrollSyncToken = 0;
const copiedScroll = new WeakMap();
const nextScrollFrame = globalThis.requestAnimationFrame || ((callback) => setTimeout(callback, 0));

function suspendScrollSync() {
  scrollSyncing = true;
  const token = ++scrollSyncToken;
  // 两帧包含两个视口的异步 scroll；旧导航回调不能提前解锁新导航。
  nextScrollFrame(() => nextScrollFrame(() => {
    if (token === scrollSyncToken) scrollSyncing = false;
  }));
}

function syncScroll(from, to) {
  from.addEventListener('scroll', () => {
    const copied = copiedScroll.get(from);
    copiedScroll.delete(from);
    if (scrollSyncing) return;
    if (copied && copied.top === from.scrollTop && copied.left === from.scrollLeft) return;
    if (to.scrollTop === from.scrollTop && to.scrollLeft === from.scrollLeft) return;
    to.scrollTop = from.scrollTop;
    to.scrollLeft = from.scrollLeft;
    // 忽略这次赋值产生的回传事件，不阻塞连续的用户滚动。
    copiedScroll.set(to, { top: to.scrollTop, left: to.scrollLeft });
  });
}
syncScroll(treeLeftEl, treeRightEl);
syncScroll(treeRightEl, treeLeftEl);

/* ================= 事件绑定 ================= */
$('btn-compare').addEventListener('click', doCompare);
$('btn-swap').addEventListener('click', doSwap);
$('btn-sample').addEventListener('click', fillSample);
$('btn-clear').addEventListener('click', doClear);
$('view-struct').addEventListener('click', () => setCompareView('struct'));
$('view-text').addEventListener('click', () => setCompareView('text'));
$('diff-prev').addEventListener('click', () => goToDiff(state.diffIndex - 1));
$('diff-next').addEventListener('click', () => goToDiff(state.diffIndex + 1));

arrayModeSel.addEventListener('change', () => {
  keyFieldBox.hidden = arrayModeSel.value !== 'key';
});

onlyDiffChk.addEventListener('change', () => {
  state.onlyDiff = onlyDiffChk.checked;
  state.treesDirty = true;
  if (state.result && state.view === 'struct' && comparingVersion === null && state.leftData !== undefined) refreshTrees();
});

for (const el of [inputLeft, inputRight]) {
  el.addEventListener('input', () => {
    dataVersion++;
    runTask.cancel({ onlyIfBusy: true });
  });
  el.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      doCompare();
    }
  });
}
