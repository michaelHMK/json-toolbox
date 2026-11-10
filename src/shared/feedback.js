import { t } from './i18n.js';

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

  function showParseError(text, result) {
    let message = t('errParseFailed') + result.error;
    if (typeof result.line === 'number') {
      message = t('errLineCol', [String(result.line), String(result.column)]) + result.error;
    }
    showError(message);
    if (typeof result.position === 'number') {
      selectInputPosition?.(Math.max(0, Math.min(result.position, text.length)), result.line || 1);
    }
  }

  return { setStatus, showError, hideError, showParseError };
}
