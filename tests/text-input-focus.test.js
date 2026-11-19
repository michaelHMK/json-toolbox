import test from 'node:test';
import assert from 'node:assert/strict';
import { Element, loadPage } from './helpers/page-dom.js';
import { createTextInput, LARGE_INPUT_THRESHOLD } from '../src/shared/text-input.js';

const largeText = '"' + 'x'.repeat(LARGE_INPUT_THRESHOLD + 1) + '"';

function setup() {
  const requests = [];
  const page = loadPage('formatter', {
    expose: '{ textInput, document }',
    runTask: async (action, payload) => {
      requests.push({ action, ...payload });
      return { ok: true, result: { text: '[]' } };
    },
  });
  // The shared DOM helper intentionally omits browser focus management. Keep
  // this test's activeElement bookkeeping local; real focus is verified in
  // bench/input-focus.mjs.
  const focusCalls = [];
  for (const id of ['input', 'input-editor', 'btn-format']) {
    const element = page.get(id);
    element.focus = () => {
      page.document.activeElement = element;
      focusCalls.push(id);
    };
  }
  return { ...page, requests, focusCalls };
}

function transfer(text, type) {
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  event[type === 'paste' ? 'clipboardData' : 'dataTransfer'] = { types: ['text/plain'], getData: () => text };
  return event;
}

for (const type of ['paste', 'drop']) {
  test(`${type} transfers the selection and keyboard focus to the large editor`, async () => {
    const page = setup();
    const input = page.get('input');
    const editor = page.get('input-editor');
    input.value = '[0]';
    input.setSelectionRange(1, 2);
    input.focus();
    const event = transfer(largeText, type);
    input.events[type](event);
    assert.equal(event.prevented, true);
    assert.equal(page.textInput.getText(), '[' + largeText + ']');
    assert.equal(input.value, '');
    assert.equal(input.hidden, true);
    assert.equal(editor.hidden, false);
    assert.equal(page.document.activeElement, editor);
    assert.equal(editor.selectionStart, 1 + largeText.length);
    assert.equal(editor.selectionEnd, editor.selectionStart);
    editor.events.keydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
    await Promise.resolve();
    assert.equal(page.requests.at(-1).action, 'format');
    assert.equal(page.requests.at(-1).text, '[' + largeText + ']');
  });
}

test('editing a large document down to a small value keeps its editor active', async () => {
  const page = setup();
  const input = page.get('input');
  const host = page.get('input-editor');
  input.focus();
  page.textInput.setText(largeText);
  host.editor.replace(0, host.editor.length, '{"small":true}');
  assert.equal(page.textInput.getText(), '{"small":true}');
  assert.equal(host.hidden, false);
  assert.equal(page.document.activeElement, host);
  host.events.keydown({ key: 'Enter', metaKey: true, preventDefault() {} });
  await Promise.resolve();
  assert.equal(page.requests.at(-1).text, '{"small":true}');
});

test('files with a large text representation stay on the file import path', () => {
  const page = setup();
  page.textInput.setText('[]');
  const event = transfer(largeText, 'drop');
  event.dataTransfer.types.push('Files');
  page.get('input').events.drop(event);
  assert.equal(event.prevented, false);
  assert.equal(page.textInput.getText(), '[]');
});

test('input mode changes do not take focus from another control', () => {
  const page = setup();
  const button = page.get('btn-format');
  button.focus();
  page.textInput.setText(largeText);
  assert.equal(page.document.activeElement, button);
  page.textInput.setText('{}');
  assert.equal(page.document.activeElement, button);
  page.get('input').events.drop(transfer(largeText, 'drop'));
  assert.equal(page.document.activeElement, button);
  assert.equal(page.focusCalls.length, 1);
});

test('paste at the threshold preserves native selection handling and focus', () => {
  const page = setup();
  const input = page.get('input');
  input.value = '[0]';
  input.setSelectionRange(1, 2);
  input.focus();
  const event = transfer('1'.repeat(LARGE_INPUT_THRESHOLD - 2), 'paste');
  input.events.paste(event);
  assert.equal(event.prevented, false);
  assert.equal(input.value, '[0]');
  assert.equal(input.selectionStart, 1);
  assert.equal(input.selectionEnd, 2);
  assert.equal(page.document.activeElement, input);
  assert.equal(page.focusCalls.length, 1);
});

test('format on paste formats the complete replacement once', async () => {
  const page = setup();
  const input = page.get('input');
  input.value = '[0]';
  input.setSelectionRange(1, 2);
  page.get('auto-format').checked = true;

  input.events.paste(transfer(largeText, 'paste'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(page.requests.map((request) => request.action), ['format']);
  assert.equal(page.requests[0].text, '[' + largeText + ']');
});

test('clearing a focused large editor restores the textarea without refocusing unchanged modes', () => {
  const page = setup();
  const input = page.get('input');
  input.focus();
  page.textInput.setText('[]');
  assert.equal(page.focusCalls.length, 1);
  page.textInput.setText(largeText);
  page.textInput.setText('[' + largeText + ']');
  assert.equal(page.focusCalls.length, 2);
  page.textInput.clear();
  assert.equal(page.document.activeElement, input);
  assert.equal(page.focusCalls.length, 3);
});

test('lazy large-editor loading preserves source, focus, selection, cancellation and fallback', async () => {
  const doc = { activeElement: null, body: {} };
  const textarea = new Element('textarea');
  const host = new Element('div');
  textarea.ownerDocument = doc;
  host.ownerDocument = doc;
  textarea.focus = () => { doc.activeElement = textarea; };
  host.focus = () => { doc.activeElement = host; };

  let resolveLoad;
  let rejectLoad;
  let mounts = 0;
  const mockFactory = (target, { text, onChange }) => {
    mounts++;
    target.value = text;
    target.editor = {
      setDocument(v) { target.value = v; },
      replace(from, to, v) { target.value = target.value.slice(0, from) + v + target.value.slice(to); onChange(); },
      getText: () => target.value,
      hasContent: () => Boolean(target.value.trim()),
      get length() { return target.value.length; },
      select(start, end) { target.setSelectionRange(start, end); },
      focus() { target.focus(); },
      destroy() { delete target.editor; },
    };
    return target.editor;
  };

  let changes = 0;
  const textInput = createTextInput(textarea, host, {
    threshold: 8,
    loadEditor: () => new Promise((resolve, reject) => { resolveLoad = resolve; rejectLoad = reject; }),
  });
  textInput.bindEvents({ onChange: () => changes++, onRun: () => {} });

  // Clearing while the editor chunk is still loading cancels the stale mount.
  textarea.focus();
  textInput.setText('123456789');
  assert.equal(textInput.getText(), '123456789');
  assert.equal(textInput.hasContent(), true);
  assert.equal(textarea.hidden, true);
  textInput.clear();
  resolveLoad(mockFactory);
  await Promise.resolve();
  assert.equal(mounts, 0);
  assert.equal(textarea.hidden, false);
  assert.equal(doc.activeElement, textarea);

  // Paste while loading notifies once synchronously, applies pending selection when ready.
  textarea.value = '[]';
  textarea.setSelectionRange(1, 1);
  textarea.focus();
  const paste = transfer('123456789', 'paste');
  textarea.events.paste(paste);
  assert.equal(paste.prevented, true);
  assert.equal(changes, 1);
  assert.equal(textInput.getText(), '[123456789]');
  textInput.selectPosition(3, 1);
  resolveLoad(mockFactory);
  await Promise.resolve();
  assert.equal(mounts, 1);
  assert.equal(changes, 1, 'initial replay must not re-fire onChange');
  assert.equal(host.value, '[123456789]');
  assert.equal(host.selectionStart, 3);
  assert.equal(doc.activeElement, host);

  // Failed lazy load falls back cleanly to the textarea without dropping text.
  textInput.clear();
  textarea.focus();
  textInput.setText('abcdefghi');
  rejectLoad(new Error('load failed'));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(textarea.hidden, false);
  assert.equal(host.hidden, true);
  assert.equal(textarea.value, 'abcdefghi');
  assert.equal(doc.activeElement, textarea);
});
