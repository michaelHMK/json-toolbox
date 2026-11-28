import { initializePage } from '../shared/page.js';
import { t } from '../shared/i18n.js';
import { hasNonWhitespace } from '../core/text-lines.js';
import { createTaskRunner } from '../shared/worker-client.js';
import { createSessionGuard } from '../shared/session-guard.js';
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
const swapHref = document.body.dataset.swapHref;
const isYamlInput = action === 'fromYaml';
const indentEl = isYamlInput ? document.getElementById('indent') : null;
const swapDirectionBtn = swapHref ? document.getElementById('btn-swap-direction') : null;

let outputText = '';
let hasOutput = false;
const guard = createSessionGuard();

const runTask = createTaskRunner({
  serialize: true,
  onBusyChange: createBusyFeedback({
    busyEl, cancelEl: document.getElementById('btn-cancel'),
    onCancel: () => { guard.advance(); runTask.cancel(); setStatus(t('statusCancelled')); },
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
  extensions: isYamlInput ? ['.yaml', '.yml'] : ['.json'],
  typeErrorKey: isYamlInput ? 'errFileTypeYaml' : 'errFileType',
  multipleErrorKey: isYamlInput ? 'errFileMultipleYaml' : 'errFileMultiple',
  onImport: ({ text }) => {
    resetDocument();
    textInput.setText(text);
    if (text.length > LARGE_INPUT_THRESHOLD) {
      guard.defer(() => { void runTransform(); });
    } else {
      void runTransform();
    }
  },
  onError: showError,
});

function needsWhitespaceCheck() {
  return action === 'minify' || action === 'toYaml' || action === 'fromYaml';
}

async function runTransform() {
  const text = textInput.getText();
  if (needsWhitespaceCheck() ? !hasNonWhitespace(text) : !text) {
    const emptyKey = action === 'fromYaml'
      ? 'errNeedYamlInput'
      : (action === 'minify' || action === 'toYaml') ? 'errNeedInput' : 'errNeedContent';
    showError(t(emptyKey));
    return;
  }
  hideError();
  runTask.cancel({ onlyIfBusy: true });
  const version = guard.advance();
  const payload = {
    text,
    retainSearch: false,
    includeTextIndex: true,
    ...(indentEl ? { indent: indentEl.value || '2' } : {}),
  };
  const res = await runTask(action, payload, { key: 'transform' });
  if (res.cancelled) return;
  if (!guard.isCurrent(version)) return;
  if (!res.ok) {
    if (action === 'minify' || action === 'toYaml') showParseError(text, res);
    else if (action === 'fromYaml') showParseError(text, res, 'errYamlParseFailed');
    else if (action === 'unescape') showParseError(text, res, 'errUnescapeFailed');
    else showError(taskErrorMessage(res));
    return;
  }
  outputText = res.result.text;
  hasOutput = true;
  outputView.setText(outputText, res.result.lineIndex);
  if (action === 'minify') {
    let status = t('statusMinified', [outputText.length.toLocaleString(), String(res.duration)]);
    if (res.result.lenient) status += ' · ' + t('statusLenientParsed');
    setStatus(status);
  } else if (action === 'toYaml') {
    let status = t('statusYamlGenerated', [outputText.length.toLocaleString(), String(res.duration)]);
    if (res.result.lenient) status += ' · ' + t('statusLenientParsed');
    setStatus(status);
  } else if (action === 'fromYaml') {
    let status = t('statusJsonFromYaml', [outputText.length.toLocaleString(), String(res.duration)]);
    if (res.result.multiDocument) {
      status += ' · ' + t('statusYamlMultiDoc', [String(res.result.documentCount)]);
    }
    setStatus(status);
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
  guard.advance();
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
  const brand = appName === 'appName' ? 'JSON Toolbox' : appName;
  if (action === 'fromYaml') {
    textInput.setText([
      '# Sample Kubernetes Deployment',
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      `  name: ${JSON.stringify(brand)}`,
      '  labels:',
      "    country: 'NO'",
      "    port: '0123'",
      'spec:',
      '  replicas: 2',
      '  template:',
      '    spec:',
      '      containers:',
      '        - name: web',
      '          ports:',
      '            - containerPort: 8080',
    ].join('\n'));
  } else {
    const sample = JSON.stringify({
      name: brand,
      free: true,
      tags: ['local', 'fast'],
      nested: { id: 1, value: null },
    }, null, 2);
    textInput.setText(action === 'unescape' ? JSON.stringify(sample).slice(1, -1) : sample);
  }
  hideError();
  runTransform();
}

const TRANSFER_PREFIX = 'json-toolbox.transfer:';

async function saveTransfer(text) {
  const token = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const key = TRANSFER_PREFIX + token;
  if (typeof chrome !== 'undefined' && chrome.storage?.session) {
    await chrome.storage.session.set({ [key]: { text } });
    return token;
  }
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.setItem(key, JSON.stringify({ text }));
    return token;
  }
  return null;
}

async function takeTransfer(token) {
  const key = TRANSFER_PREFIX + token;
  if (typeof chrome !== 'undefined' && chrome.storage?.session) {
    const data = await chrome.storage.session.get(key);
    await chrome.storage.session.remove(key);
    return data?.[key]?.text ?? null;
  }
  if (typeof sessionStorage !== 'undefined') {
    const raw = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw)?.text ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

async function doSwapDirection() {
  if (!swapHref) return;
  const text = hasOutput ? outputText : textInput.getText();
  let target = swapHref;
  if (text) {
    try {
      const token = await saveTransfer(text);
      if (token) target = `${swapHref}?transfer=${encodeURIComponent(token)}`;
    } catch {
      // Fall back to navigating without prefilling if session storage quota is exceeded.
    }
  }
  if (typeof location !== 'undefined' && typeof location.assign === 'function') {
    location.assign(target);
  }
}

async function checkPendingTransfer() {
  if (typeof location === 'undefined' || !location.search) return;
  const params = new URLSearchParams(location.search);
  const token = params.get('transfer');
  if (!token) return;
  if (typeof history !== 'undefined' && typeof history.replaceState === 'function') {
    history.replaceState(null, '', location.pathname);
  }
  const text = await takeTransfer(token);
  if (typeof text !== 'string' || !text) return;
  textInput.setText(text);
  if (text.length > LARGE_INPUT_THRESHOLD) {
    guard.defer(() => { void runTransform(); });
  } else {
    void runTransform();
  }
}

document.getElementById('btn-run').addEventListener('click', runTransform);
document.getElementById('btn-copy').addEventListener('click', doCopy);
document.getElementById('btn-clear').addEventListener('click', doClear);
document.getElementById('btn-sample').addEventListener('click', fillSample);
swapDirectionBtn?.addEventListener('click', () => { void doSwapDirection(); });

textInput.bindEvents({
  onChange() {
    fileImport.reset();
    guard.advance();
    runTask.cancel({ onlyIfBusy: true });
  },
  onRun: runTransform,
});

void checkPendingTransfer();
