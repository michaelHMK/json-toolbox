import { initializePage } from '../shared/page.js';
import { t } from '../shared/i18n.js';
import { createTaskRunner } from '../shared/worker-client.js';
import { createFeedback, createBusyFeedback, taskErrorMessage } from '../shared/feedback.js';
import { createFileImport } from '../shared/file-import.js';
import { createTextInput, LARGE_INPUT_THRESHOLD } from '../shared/text-input.js';
import { createVirtualTextView } from '../shared/virtual-text.js';

initializePage();

const inputEl = document.getElementById('input');
const inputEditorEl = document.getElementById('input-editor');
const outputEl = document.getElementById('output-text');
const statusEl = document.getElementById('status');
const busyEl = document.getElementById('busy');
const errorEl = document.getElementById('error');
const action = document.body.dataset.action;

let outputText = '';
let hasOutput = false;
let dataVersion = 0;

const runTask = createTaskRunner({
  serialize: true,
  onBusyChange: createBusyFeedback({
    busyEl, cancelEl: document.getElementById('btn-cancel'),
    onCancel: () => { dataVersion++; runTask.cancel(); setStatus(t('statusCancelled')); },
  }),
});

const { setStatus, showError, hideError, showParseError, copyWithFeedback } = createFeedback({
  statusEl, errorEl, selectInputPosition: (position, line) => textInput.selectPosition(position, line),
});
const textInput = createTextInput(inputEl, inputEditorEl);
const outputView = createVirtualTextView(outputEl, { copy: copyWithFeedback });

const fileImport = createFileImport({
  dropZone: document.getElementById('input-pane'),
  fileInput: document.getElementById('file-input'),
  triggerEl: document.getElementById('btn-import'),
  fileNameEl: document.getElementById('file-name'),
  dropHint: document.getElementById('file-drop-hint'),
  onImport: ({ text }) => {
    resetDocument();
    textInput.setText(text);
    if (text.length > LARGE_INPUT_THRESHOLD) {
      const version = dataVersion;
      setTimeout(() => { if (version === dataVersion) void runTransform(); }, 0);
    } else {
      void runTransform();
    }
  },
  onError: showError,
});

async function runTransform() {
  const text = textInput.getText();
  if (action === 'minify' ? !text.trim() : !text) {
    showError(t(action === 'minify' ? 'errNeedInput' : 'errNeedContent'));
    return;
  }
  hideError();
  runTask.cancel({ onlyIfBusy: true });
  const version = ++dataVersion;
  const res = await runTask(action, { text, retainSearch: false, includeTextIndex: true }, { key: 'transform' });
  if (res.cancelled) return;
  if (version !== dataVersion) return;
  if (!res.ok) {
    if (action === 'minify') showParseError(text, res);
    else if (action === 'unescape') showParseError(text, res, 'errUnescapeFailed');
    else showError(taskErrorMessage(res));
    return;
  }
  outputText = res.result.text;
  hasOutput = true;
  outputView.setText(outputText, res.result.lineIndex);
  if (action === 'minify') {
    setStatus(t('statusMinified', [outputText.length.toLocaleString(), String(res.duration)]));
  } else {
    setStatus(t(action === 'escape' ? 'statusEscaped' : 'statusUnescaped', [outputText.length.toLocaleString(), String(res.duration)]));
  }
}

async function doCopy() {
  const text = hasOutput ? outputText : textInput.getText();
  if (!hasOutput && !text) {
    showError(t('errNothingToCopy'));
    return;
  }
  await copyWithFeedback(text);
}

function resetDocument() {
  dataVersion++;
  runTask('clear', {}, { discardQueued: true });
  textInput.clear();
  outputText = '';
  hasOutput = false;
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

textInput.bindEvents({
  onChange() {
    fileImport.reset();
    dataVersion++;
    runTask.cancel({ onlyIfBusy: true });
  },
  onRun: runTransform,
});
