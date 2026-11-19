import { initializePage } from '../shared/page.js';
import { t } from '../shared/i18n.js';
import { hasNonWhitespace } from '../core/text-lines.js';
import { createComparisonSession } from '../shared/comparison-session.js';
import { createFeedback, createBusyFeedback, taskErrorMessage } from '../shared/feedback.js';
import { createVirtualTree } from '../shared/virtual-tree.js';
import { createFileImport } from '../shared/file-import.js';
import { createTextInput } from '../shared/text-input.js';
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
  onlyDiff: false,
  diffIndex: -1,
  expanded: { left: new Set(), right: new Set() },     // 用户手动展开
  collapsed: { left: new Set(), right: new Set() },
  diffMap: { left: new Map(), right: new Map() },      // path → diff 记录
  pairLR: new Map(),   // 主键配对导致的左路径 → 右路径
  pairRL: new Map(),
};

const treeViews = { left: null, right: null };
const pendingToggles = new Set();
let comparison = null;

const session = createComparisonSession({
  onBusyChange: createBusyFeedback({
    busyEl, cancelEl: $('btn-cancel'),
    onCancel: () => { session.cancel(); setStatus(t('statusCancelled')); },
  }),
});

/* ================= 状态展示 ================= */
const { setStatus, showError, hideError, showParseError, copyWithFeedback } = createFeedback({
  statusEl, errorEl,
  selectInputPosition: (position, line, side) => textInputs[side === 'right' ? 'right' : 'left'].selectPosition(position, line),
});
const textInputs = {
  left: createTextInput(inputLeft, $('input-editor-left')),
  right: createTextInput(inputRight, $('input-editor-right')),
};
const textRenderer = createVirtualTextView(textView, { copy: copyWithFeedback });

const fileImports = {};
for (const side of ['left', 'right']) {
  fileImports[side] = createFileImport({
    dropZone: $('input-pane-' + side), fileInput: $('file-input-' + side),
    triggerEl: $('btn-import-' + side), fileNameEl: $('file-name-' + side),
    dropHint: $('file-drop-hint-' + side), onError: showError,
    onImport: ({ text }) => {
      session.cancel({ onlyIfBusy: true });
      textInputs[side].setText(text);
      if (textInputs.left.hasContent() && textInputs.right.hasContent()) {
        // Preparing the editor and cloning both inputs must not share one
        // long UI task. A later edit, clear or manual compare supersedes this.
        session.defer(() => { void doCompare(); });
      }
    },
  });
}

/* ================= 对比主流程 ================= */
async function doCompare() {
  const lt = textInputs.left.getText();
  const rt = textInputs.right.getText();
  if (!hasNonWhitespace(lt) || !hasNonWhitespace(rt)) {
    showError(t('errNeedBothSides'));
    return;
  }
  hideError();
  const ignorePaths = ignoreInput.value
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const keyField = arrayModeSel.value === 'key' ? keyFieldInput.value.trim() : '';
  let applied = false;
  const res = await session.compare({ text: lt, text2: rt, keyField, ignorePaths }, (response) => {
    applied = true;
    if (!response.ok) {
      showParseError(response.side === 'right' ? rt : lt, response, 'errCompareFailed');
      return;
    }
    comparison = response.comparison;
    state.result = response.result;
    state.textResult = null;
    state.treesDirty = true;
    // 文本模式也释放上一轮结构视图，避免隐藏 DOM 的闭包保留旧数据。
    treeLeftEl.replaceChildren();
    treeRightEl.replaceChildren();
    textRenderer.clear();
    destroyTrees();
    clearIndexes();
    state.diffIndex = -1;
    resultEl.hidden = false;
  });
  if (!applied || !res.ok) return;
  let followup;
  const started = session.apply(res, () => {
    followup = state.view === 'text' ? loadTextDiff(res.comparison) : refreshTrees();
  });
  if (!started || !(await followup)) return;
  session.apply(res, updateStatus);
}

function clearIndexes() {
  state.indexesReady = false;
  pendingToggles.clear();
  for (const side of ['left', 'right']) {
    state.diffMap[side].clear();
    state.expanded[side].clear();
    state.collapsed[side].clear();
  }
  state.pairLR.clear();
  state.pairRL.clear();
}

function buildIndexes() {
  const r = state.result;
  for (const [left, right] of r.pairs) {
    state.pairLR.set(left, right);
    state.pairRL.set(right, left);
  }
  for (const d of r.diffs) {
    if (d.leftPath !== null) state.diffMap.left.set(d.leftPath, d);
    if (d.rightPath !== null) state.diffMap.right.set(d.rightPath, d);
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
async function refreshTrees() {
  const updates = renderTrees();
  if (state.result && state.result.diffs.length) {
    const navigation = navigateToDiff(0);
    const results = await Promise.all([
      navigation.left ?? updates.left,
      navigation.right ?? updates.right,
    ]);
    return results.every((value) => value !== false);
  }
  updateDiffInfo();
  const results = await Promise.all([updates.left, updates.right]);
  return results.every((value) => value !== false);
}

function destroyTrees() {
  for (const side of ['left', 'right']) {
    treeViews[side]?.destroy();
    treeViews[side] = null;
  }
}

function containsIndex(ranges, index) {
  let low = 0;
  let high = ranges.length / 2;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (ranges[mid * 2 + 1] < index) low = mid + 1;
    else high = mid;
  }
  return ranges[low * 2] <= index;
}

async function syncToggle(displayed, side, path, open) {
  for (const pending of pendingToggles) {
    if (pending[side] === path) pendingToggles.delete(pending);
  }
  const pairs = side === 'left' ? state.pairLR : state.pairRL;
  let ancestor = path;
  while (ancestor !== '') {
    if (pairs.has(ancestor)) break;
    const slash = ancestor.lastIndexOf('/');
    const parent = ancestor.slice(0, slash);
    const ranges = state.result.unpaired?.[side].get(parent);
    if (ranges && containsIndex(ranges, Number(ancestor.slice(slash + 1)))) return;
    ancestor = parent;
  }
  const target = (pairs.get(ancestor) ?? '') + path.slice(ancestor.length);
  const other = side === 'left' ? 'right' : 'left';
  if (state.result.pairsTruncated && path !== ancestor) {
    const pending = { [side]: path, [other]: target };
    pendingToggles.add(pending);
    const response = await displayed.checkPair(side, path, ancestor);
    if (!pendingToggles.delete(pending)) return;
    let update;
    session.apply(response, () => {
      if (!response.ok) showError(taskErrorMessage(response));
      else if (response.result.allowed) update = treeViews[other]?.setOpen(target, open);
    });
    return update;
  }
  return treeViews[other]?.setOpen(target, open);
}

function renderTrees() {
  const displayed = comparison;
  if (!displayed) return { left: Promise.resolve(false), right: Promise.resolve(false) };
  if (!state.indexesReady) buildIndexes();
  state.treesDirty = false;
  const pending = {};
  for (const side of ['left', 'right']) {
    const options = {
      expanded: state.expanded[side],
      collapsed: state.collapsed[side],
      onlyRequired: state.onlyDiff,
      decorations: state.diffMap[side],
      onToggle(path, open) {
        suspendScrollSync(syncToggle(displayed, side, path, open));
      },
    };
    if (treeViews[side]) pending[side] = treeViews[side].update(options);
    else {
      const element = side === 'left' ? treeLeftEl : treeRightEl;
      treeViews[side] = createVirtualTree(element, { ...options, request: (payload) => requestTree(displayed, side, payload) });
      pending[side] = treeViews[side].ready;
    }
  }
  return pending;
}

async function requestTree(displayed, side, payload) {
  const pending = displayed.requestTree(side, payload);
  if (payload.operation !== 'rows') suspendScrollSync(pending);
  const response = await pending;
  const applied = session.apply(response, () => {
    if (!response.ok && response.code !== 'TREE_MODEL_UNAVAILABLE') showError(taskErrorMessage(response));
  });
  return applied ? response : { ok: false, cancelled: true };
}

/* ================= 差异导航 ================= */
function navigateToDiff(i) {
  const diffs = state.result ? state.result.diffs : [];
  if (!diffs.length) {
    state.diffIndex = -1;
    updateDiffInfo();
    return {};
  }
  state.diffIndex = ((i % diffs.length) + diffs.length) % diffs.length;
  const diff = diffs[state.diffIndex];
  // 配对后的两侧行号可能相距很远；本次导航各自定位，避免 scroll 事件互相覆盖。
  const pending = {};
  for (const side of ['left', 'right']) {
    const path = side === 'left' ? diff.leftPath : diff.rightPath;
    if (path !== null && treeViews[side]) pending[side] = treeViews[side].reveal(path);
    treeViews[side]?.setCurrent(path);
  }
  suspendScrollSync(Promise.allSettled(Object.values(pending)));
  updateDiffInfo();
  return pending;
}

function goToDiff(i) {
  return Promise.all(Object.values(navigateToDiff(i)));
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
async function loadTextDiff(displayed = comparison) {
  if (!displayed) return false;
  const res = await displayed.textDiff();
  const applied = session.apply(res, () => {
    if (!res.ok) {
      showError(t('errTextDiffFailed') + taskErrorMessage(res));
      return;
    }
    state.textResult = res.result;
    renderTextDiff();
  });
  return applied && res.ok;
}

function renderTextDiff() {
  textRenderer.setDiff(state.textResult);
}

/* ================= 视图切换 ================= */
async function setCompareView(view) {
  state.view = view;
  $('view-struct').classList.toggle('active', view === 'struct');
  $('view-text').classList.toggle('active', view === 'text');
  $('view-struct').setAttribute('aria-pressed', String(view === 'struct'));
  $('view-text').setAttribute('aria-pressed', String(view === 'text'));
  structView.hidden = view !== 'struct';
  textView.hidden = view !== 'text';
  diffNavEl.style.visibility = view === 'struct' ? '' : 'hidden';
  if (!state.result || session.pending) return;
  if (view === 'text') await loadTextDiff();
  else if (state.treesDirty) {
    const ok = await refreshTrees();
    if (!ok) state.treesDirty = true;
  } else {
    treeViews.left?.refresh();
    treeViews.right?.refresh();
  }
}

/* ================= 其他操作 ================= */
function doSwap() {
  session.cancel({ onlyIfBusy: true });
  const leftText = textInputs.left.getText();
  textInputs.left.setText(textInputs.right.getText());
  textInputs.right.setText(leftText);
  fileImports.left.reset();
  fileImports.right.reset();
  if (state.result) doCompare();
}

function doClear() {
  session.clear();
  comparison = null;
  destroyTrees();
  clearIndexes();
  textInputs.left.clear();
  textInputs.right.clear();
  fileImports.left.reset();
  fileImports.right.reset();
  state.result = null;
  state.treesDirty = true;
  state.textResult = null;
  state.diffIndex = -1;
  resultEl.hidden = true;
  treeLeftEl.replaceChildren();
  treeRightEl.replaceChildren();
  textRenderer.clear();
  hideError();
  setStatus('');
  updateDiffInfo();
  inputLeft.focus();
}

function fillSample() {
  fileImports.left.reset();
  fileImports.right.reset();
  textInputs.left.setText(JSON.stringify({
    version: 1,
    users: [
      { id: 1, name: 'Alice', role: 'admin' },
      { id: 2, name: 'Bob', role: 'user' },
    ],
    updatedAt: '2026-08-01',
  }, null, 2));
  textInputs.right.setText(JSON.stringify({
    version: 2,
    users: [
      { id: 2, name: 'Bob', role: 'admin' },
      { id: 3, name: 'Carol', role: 'user' },
    ],
    updatedAt: '2026-08-24',
  }, null, 2));
  hideError();
  doCompare();
}

/* ================= 滚动同步 ================= */
let scrollSyncing = false;
let scrollSyncHolds = 0;
const copiedScroll = new WeakMap();
const nextScrollFrame = globalThis.requestAnimationFrame || ((callback) => setTimeout(callback, 0));

function suspendScrollSync(pending) {
  scrollSyncing = true;
  scrollSyncHolds++;
  // Tree navigation settles asynchronously across Worker windows. Keep both
  // positions independent until every operation settles and its scroll paints.
  const release = () => nextScrollFrame(() => nextScrollFrame(() => {
    if (--scrollSyncHolds === 0) scrollSyncing = false;
  }));
  Promise.resolve(pending).then(release, release);
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
  }, { passive: true });
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
  if (state.result && state.view === 'struct' && !session.pending) return refreshTrees();
});

for (const side of ['left', 'right']) {
  textInputs[side].bindEvents({
    onChange() {
      fileImports[side].reset();
      session.cancel({ onlyIfBusy: true });
    },
    onRun: doCompare,
  });
}
