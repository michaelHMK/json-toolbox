import { createVirtualTextView } from './virtual-text.js';

export const LARGE_INPUT_THRESHOLD = 256 * 1024;

export function createTextInput(textarea, preview, { threshold = LARGE_INPUT_THRESHOLD } = {}) {
  const view = preview ? createVirtualTextView(preview) : null;
  let source = '';
  let large = false;

  function setText(text) {
    large = view !== null && text.length > threshold;
    if (large) {
      source = text;
      textarea.hidden = true;
      textarea.value = '';
      preview.hidden = false;
      view.setText(text);
      return;
    }
    source = '';
    if (preview) preview.hidden = true;
    view?.clear();
    textarea.hidden = false;
    textarea.value = text;
  }

  // Intercept before the browser lays out a multi-megabyte textarea value.
  // Native paste keeps its selection semantics until it crosses the limit;
  // pasting into the read-only preview replaces that document.
  function acceptTransfer(event) {
    if (!view) return false;
    const transfer = event.clipboardData || event.dataTransfer;
    if (!transfer || Array.from(transfer.types || []).includes('Files')) return false;
    const text = transfer.getData('text/plain');
    if (!text) return false;
    const previous = large ? '' : textarea.value;
    const start = large ? 0 : (textarea.selectionStart ?? previous.length);
    const end = large ? 0 : (textarea.selectionEnd ?? start);
    if (!large && previous.length - (end - start) + text.length <= threshold) return false;
    event.preventDefault();
    setText(previous.slice(0, start) + text + previous.slice(end));
    return true;
  }

  return {
    setText,
    acceptTransfer,
    getText() { return large ? source : textarea.value; },
    clear() { setText(''); },
    isLarge() { return large; },
    focus() { (large ? preview : textarea).focus(); },
    selectPosition(position, line = 1) {
      if (large) {
        view.revealPosition(position);
        return;
      }
      position = Math.max(0, Math.min(position, textarea.value.length));
      textarea.focus();
      textarea.setSelectionRange(position, Math.min(position + 1, textarea.value.length));
      const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 21;
      textarea.scrollTop = Math.max(0, (line - 3) * lineHeight);
    },
  };
}
