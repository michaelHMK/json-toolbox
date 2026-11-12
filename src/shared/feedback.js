import { t } from './i18n.js';

const ERROR_KEYS = {
  INVALID_JSON: 'errInvalidJson',
  INVALID_ESCAPE: 'errInvalidEscape',
  SEARCH_NOT_READY: 'errNothingToParse',
  SNAPSHOT_UNAVAILABLE: 'errSnapshotUnavailable',
  UNKNOWN_ACTION: 'errTaskFailed',
  TASK_FAILED: 'errTaskFailed',
  WORKER_FAILED: 'errWorkerFailed',
};

export function taskErrorMessage(result) {
  return ERROR_KEYS[result.code] ? t(ERROR_KEYS[result.code]) : result.error;
}

export function createBusyFeedback({ busyEl, cancelEl, onCancel }) {
  let timer = null;
  cancelEl.addEventListener('click', onCancel);
  return (busy) => {
    busyEl.hidden = !busy;
    if (!busy) {
      clearTimeout(timer);
      timer = null;
      cancelEl.hidden = true;
    } else if (timer === null) {
      timer = setTimeout(() => { cancelEl.hidden = false; }, 1000);
    }
  };
}

export function createFeedback({ statusEl, errorEl, selectInputPosition }) {
  function setStatus(text) {
    statusEl.textContent = text;
  }

  function showError(text) {
    errorEl.textContent = text;
    errorEl.hidden = false;
  }

  function hideError() {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }

  function showParseError(text, result, prefixKey = 'errParseFailed') {
    const detail = taskErrorMessage(result);
    let message = t(prefixKey);
    if (result.side) message += t(result.side === 'right' ? 'paneNew' : 'paneOld') + ': ';
    if (typeof result.line === 'number') {
      message += t('errLineCol', [String(result.line), String(result.column)]);
    }
    showError(message + detail);
    if (typeof result.position === 'number') {
      selectInputPosition?.(Math.max(0, Math.min(result.position, text.length)), result.line || 1, result.side);
    }
  }

  return { setStatus, showError, hideError, showParseError };
}
