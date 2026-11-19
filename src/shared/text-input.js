import { hasNonWhitespace } from '../core/text-lines.js';

export const LARGE_INPUT_THRESHOLD = 256 * 1024;

let cachedLargeEditorFactory = null;
let pendingLargeEditorLoad = null;

function defaultLoadLargeEditor() {
  if (cachedLargeEditorFactory) return Promise.resolve(cachedLargeEditorFactory);
  pendingLargeEditorLoad ??= import('./large-input-editor.js').then((module) => {
    cachedLargeEditorFactory = module.createLargeInputEditor;
    return cachedLargeEditorFactory;
  }, (error) => {
    pendingLargeEditorLoad = null;
    throw error;
  });
  return pendingLargeEditorLoad;
}

export function createTextInput(textarea, host, {
  threshold = LARGE_INPUT_THRESHOLD,
  createEditor = typeof createLargeInputEditor === 'function' ? createLargeInputEditor : null,
  loadEditor = defaultLoadLargeEditor,
} = {}) {
  const doc = textarea.ownerDocument || document;
  let editor = null;
  let source = null;
  let notifyChange;
  let modeVersion = 0;
  let syncingEditor = false;
  let loadingEditor = false;
  let pendingFocus = false;
  let pendingSelection = null;

  function edited() {
    if (syncingEditor) return;
    source = null;
    notifyChange?.();
  }

  function resolveFactory() {
    if (createEditor) return createEditor;
    if (loadEditor === defaultLoadLargeEditor) return cachedLargeEditorFactory;
    return null;
  }

  function shouldRestoreFocus(hadFocus) {
    if (!hadFocus) return false;
    const active = doc.activeElement;
    return active == null || active === doc.body || active === textarea || active === host || Boolean(host.contains?.(active));
  }

  function focus() {
    if (editor) editor.focus();
    else if (loadingEditor) pendingFocus = true;
    else textarea.focus();
  }

  function applySelection(position, line) {
    if (source !== null && line !== 1) {
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
      textarea.scrollTop = Math.max(0, ((line || 1) - 3) * lineHeight);
    }
  }

  function mountEditor(factory, text, transfer, restoreFocus) {
    syncingEditor = true;
    try {
      if (editor) {
        if (transfer) {
          editor.setDocument(transfer.previous);
          editor.replace(transfer.start, transfer.end, transfer.text);
        } else {
          editor.setDocument(text);
        }
      } else {
        editor = factory(host, {
          text: transfer ? transfer.previous : text,
          label: textarea.getAttribute('aria-label'),
          onChange: edited,
        });
        if (transfer) editor.replace(transfer.start, transfer.end, transfer.text);
      }
    } finally {
      syncingEditor = false;
    }
    if (pendingSelection) {
      const next = pendingSelection;
      pendingSelection = null;
      pendingFocus = false;
      applySelection(next.position, next.line);
    } else if (restoreFocus) {
      pendingFocus = false;
      editor.focus();
    }
  }

  function showEditor(text, transfer = null) {
    const version = ++modeVersion;
    const hadFocus = doc.activeElement === textarea || pendingFocus;
    pendingFocus = false;
    pendingSelection = null;
    textarea.hidden = true;
    textarea.value = '';
    host.hidden = false;
    const factory = resolveFactory();
    if (factory) {
      loadingEditor = false;
      mountEditor(factory, text, transfer, hadFocus);
      return;
    }
    loadingEditor = true;
    pendingFocus = hadFocus;
    Promise.resolve(loadEditor()).then((loadedFactory) => {
      if (version !== modeVersion) return;
      loadingEditor = false;
      mountEditor(loadedFactory, text, transfer, shouldRestoreFocus(pendingFocus));
    }, () => {
      if (version !== modeVersion) return;
      loadingEditor = false;
      const restore = shouldRestoreFocus(pendingFocus);
      pendingFocus = false;
      const fallbackText = source ?? text;
      host.hidden = true;
      textarea.hidden = false;
      textarea.value = fallbackText;
      if (pendingSelection) {
        const next = pendingSelection;
        pendingSelection = null;
        applySelection(next.position, next.line);
      } else if (restore) {
        textarea.focus({ preventScroll: true });
      }
    });
  }

  function setText(text) {
    // Keep the original line endings for Worker tasks until the first edit.
    if (text.length > threshold) {
      source = text;
      showEditor(text);
    } else {
      modeVersion++;
      const hadFocus = (editor && host.contains(doc.activeElement)) || (loadingEditor && shouldRestoreFocus(pendingFocus));
      loadingEditor = false;
      pendingFocus = false;
      pendingSelection = null;
      source = text.includes('\r') ? text : null;
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
    const nextSource = previous.slice(0, start) + text + previous.slice(end);
    // Notify change synchronously so stale imports/tasks clear before auto-format runs.
    notifyChange?.();
    source = nextSource;
    showEditor(nextSource, { previous, start, end, text });
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
    hasContent() {
      if (source !== null) return hasNonWhitespace(source);
      if (editor) return editor.hasContent ? editor.hasContent() : hasNonWhitespace(editor.getText());
      return hasNonWhitespace(textarea.value);
    },
    clear() { setText(''); },
    selectPosition(position, line) {
      if (loadingEditor && !editor) {
        pendingSelection = { position, line };
        pendingFocus = true;
        return;
      }
      applySelection(position, line);
    },
  };
}
