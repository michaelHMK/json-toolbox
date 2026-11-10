import { createVirtualTextView } from './virtual-text.js';

export const LARGE_INPUT_THRESHOLD = 2 * 1024 * 1024;

export function createTextInput(textarea, preview, { threshold = LARGE_INPUT_THRESHOLD } = {}) {
  const view = createVirtualTextView(preview);
  let source = '';
  let large = false;

  function setText(text, { forceTextarea = false } = {}) {
    large = !forceTextarea && text.length > threshold;
    if (large) {
      source = text;
      textarea.hidden = true;
      textarea.value = '';
      preview.hidden = false;
      view.setText(text);
      return;
    }
    source = '';
    preview.hidden = true;
    view.clear();
    textarea.hidden = false;
    textarea.value = text;
  }

  return {
    setText,
    getText() { return large ? source : textarea.value; },
    clear() { setText(''); },
    isLarge() { return large; },
    focus() { (large ? preview : textarea).focus(); },
  };
}
