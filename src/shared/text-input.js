import { createLargeInputEditor } from './large-input-editor.js';

export const LARGE_INPUT_THRESHOLD = 256 * 1024;

export function createTextInput(textarea, host, { threshold = LARGE_INPUT_THRESHOLD } = {}) {
  const doc = textarea.ownerDocument || document;
  let editor = null;
  let source = null;
  let notifyChange;

  function edited() {
    source = null;
    notifyChange?.();
  }

  function focus() {
    if (editor) editor.focus();
    else textarea.focus();
  }

  function showEditor(text) {
    const hadFocus = doc.activeElement === textarea;
    textarea.hidden = true;
    textarea.value = '';
    host.hidden = false;
    if (editor) editor.setDocument(text);
    else editor = createLargeInputEditor(host, { text, label: textarea.getAttribute('aria-label'), onChange: edited });
    if (hadFocus) editor.focus();
  }

  function setText(text) {
    // Keep the original line endings for Worker tasks until the first edit.
    if (text.length > threshold) {
      source = text;
      showEditor(text);
    } else {
      source = text.includes('\r') ? text : null;
      const hadFocus = editor && host.contains(doc.activeElement);
      editor?.destroy();
      editor = null;
      host.hidden = true;
      textarea.hidden = false;
      textarea.value = text;
      if (hadFocus) textarea.focus({ preventScroll: true });
    }
  }

  // Move a threshold-crossing paste/drop into the editor before the browser
  // lays out the textarea. One undo restores the previous text and selection.
  function transferToEditor(event) {
    const transfer = event.clipboardData || event.dataTransfer;
    if (!transfer || Array.from(transfer.types || []).includes('Files')) return false;
    const text = transfer.getData('text/plain');
    if (!text) return false;
    const previous = textarea.value;
    const start = textarea.selectionStart ?? previous.length;
    const end = textarea.selectionEnd ?? start;
    if (previous.length - (end - start) + text.length <= threshold) return false;
    event.preventDefault();
    showEditor(previous);
    editor.replace(start, end, text);
    source = previous.slice(0, start) + text + previous.slice(end);
    return true;
  }

  function bindEvents({ onChange, onRun, afterTransfer }) {
    notifyChange = onChange;
    textarea.addEventListener('input', edited);
    for (const type of ['paste', 'drop']) {
      textarea.addEventListener(type, (event) => {
        if (transferToEditor(event)) afterTransfer?.();
        else if (type === 'paste' && afterTransfer) setTimeout(afterTransfer, 0);
      });
    }
    textarea.addEventListener('dragover', (event) => {
      if (!Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
    });
    // CodeMirror handles its own paste and drop at the caret. Schedule the
    // formatter after paste just as we do for a native textarea paste.
    if (afterTransfer) host.addEventListener('paste', () => setTimeout(afterTransfer, 0), true);
    for (const target of [textarea, host]) {
      target.addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          onRun();
        }
      }, target === host);
    }
  }

  return {
    setText, bindEvents, focus,
    getText() { return source ?? (editor ? editor.getText() : textarea.value); },
    clear() { setText(''); },
    selectPosition(position, line = 1) {
      if (source !== null) {
        const original = position;
        for (let at = source.indexOf('\r\n'); at >= 0 && at < original; at = source.indexOf('\r\n', at + 2)) {
          position--;
        }
      }
      const length = editor ? editor.length : textarea.value.length;
      position = Math.max(0, Math.min(position, length));
      focus();
      const end = Math.min(position + 1, length);
      if (editor) editor.select(position, end);
      else {
        textarea.setSelectionRange(position, end);
        const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 21;
        textarea.scrollTop = Math.max(0, (line - 3) * lineHeight);
      }
    },
  };
}
