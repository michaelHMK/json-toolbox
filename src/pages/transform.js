import { initializePage } from '../shared/page.js';
import { t } from '../shared/i18n.js';
import { createTaskRunner } from '../shared/worker-client.js';
import { createFeedback, createBusyFeedback, taskErrorMessage } from '../shared/feedback.js';
import { createFileImport } from '../shared/file-import.js';
import { createTextInput } from '../shared/text-input.js';
import { copyText } from '../shared/clipboard.js';
import { createVirtualTextView } from '../shared/virtual-text.js';

initializePage();

const inputEl = document.getElementById('input');
const outputEl = document.getElementById('output-text');
const outputView = createVirtualTextView(outputEl);
const statusEl = document.getElementById('status');
const busyEl = document.getElementById('busy');
const errorEl = document.getElementById('error');
const action = document.body.dataset.action;
const textInput = createTextInput(inputEl, action === 'minify' ? document.getElementById('input-view') : null);

let outputText = '';
let dataVersion = 0;

const runTask = createTaskRunner({
  serialize: true,
  onBusyChange: createBusyFeedback({
    busyEl, cancelEl: document.getElementById('btn-cancel'),
    onCancel: () => { dataVersion++; runTask.cancel(); setStatus(t('statusCancelled')); },
  }),
});

const { setStatus, showError, hideError, showParseError } = createFeedback({
  statusEl, errorEl, selectInputPosition: textInput.selectPosition,
});

let fileImport = { reset() {} };
if (action === 'minify') {
  fileImport = createFileImport({
    dropZone: document.getElementById('input-pane'),
    fileInput: document.getElementById('file-input'),
    triggerEl: document.getElementById('btn-import'),
    fileNameEl: document.getElementById('file-name'),
    dropHint: document.getElementById('file-drop-hint'),
    onImport: ({ text }) => {
      resetDocument();
      textInput.setText(text);
      void runTransform();
    },
    onError: showError,
  });
}

async function runTransform() {
  const text = textInput.getText();
  if (action === 'minify' ? !text.trim() : !text) {
    showError(t(action === 'minify' ? 'errNeedInput' : 'errNeedContent'));
    return;
  }
  hideError();
  runTask.cancel({ onlyIfBusy: true });
  const version = ++dataVersion;
  const res = await runTask(action, { text, retainSearch: false }, { key: 'transform' });
  if (res.cancelled) return;
  if (version !== dataVersion) return;
  if (!res.ok) {
    if (action === 'minify') showParseError(text, res);
    else if (action === 'unescape') showParseError(text, res, 'errUnescapeFailed');
    else showError(taskErrorMessage(res));
    return;
  }
  outputText = res.result.text;
  outputView.setText(outputText);
  if (action === 'minify') {
    setStatus(t('statusMinified', [outputText.length.toLocaleString(), String(res.duration)]));
  } else {
    setStatus(t(action === 'escape' ? 'statusEscaped' : 'statusUnescaped', [outputText.length.toLocaleString()]));
  }
}

async function doCopy() {
  const text = outputText || textInput.getText();
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
  runTask('clear', {}, { discardQueued: true });
  textInput.clear();
  outputText = '';
  outputView.clear();
  hideError();
  setStatus('');
  textInput.focus();
}

function doClear() {
  fileImport.reset();
  resetDocument();
}

function fillSample() {
  fileImport.reset();
  const appName = t('appName');
  const sample = JSON.stringify({
    name: appName === 'appName' ? 'JSON 工具箱' : appName,
    free: true,
    tags: ['local', 'fast'],
    nested: { id: 1, value: null },
  }, null, 2);
  textInput.setText(action === 'unescape' ? JSON.stringify(sample).slice(1, -1) : sample);
  hideError();
  runTransform();
}

document.getElementById('btn-run').addEventListener('click', runTransform);
document.getElementById('btn-copy').addEventListener('click', doCopy);
document.getElementById('btn-clear').addEventListener('click', doClear);
document.getElementById('btn-sample').addEventListener('click', fillSample);

inputEl.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    runTransform();
  }
});
inputEl.addEventListener('input', () => {
  fileImport.reset();
  dataVersion++;
  runTask.cancel({ onlyIfBusy: true });
});
if (action === 'minify') {
  document.getElementById('input-view').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      runTransform();
    }
  });
}
