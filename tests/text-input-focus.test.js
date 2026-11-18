import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage } from './helpers/page-dom.js';
import { LARGE_INPUT_THRESHOLD } from '../src/shared/text-input.js';

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
