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
  for (const id of ['input', 'input-view', 'btn-format']) {
    const element = page.get(id);
    element.focus = (options) => {
      page.document.activeElement = element;
      focusCalls.push({ id, options: options && { ...options } });
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
  test(`${type} moves focused textarea to preview while preserving insertion selection and shortcuts`, async () => {
    const page = setup();
    const input = page.get('input');
    const preview = page.get('input-view');
    input.value = '[0]';
    input.setSelectionRange(1, 2);
    input.focus();
    const event = transfer(largeText, type);
    input.events[type](event);
    assert.equal(event.prevented, true);
    assert.equal(page.textInput.getText(), '[' + largeText + ']');
    assert.equal(input.value, '');
    assert.equal(input.hidden, true);
    assert.equal(page.document.activeElement, preview);
    assert.deepEqual(page.focusCalls.at(-1), { id: 'input-view', options: { preventScroll: true } });
    preview.events.keydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
    await Promise.resolve();
    assert.equal(page.requests.at(-1).action, 'format');
    assert.equal(page.requests.at(-1).text, '[' + largeText + ']');
  });

  test(`${type} moves focused preview back to textarea and keeps Ctrl+Enter usable`, async () => {
    const page = setup();
    const input = page.get('input');
    const preview = page.get('input-view');
    input.focus();
    page.textInput.setText(largeText);
    assert.equal(page.document.activeElement, preview);
    const replacement = transfer('{"small":true}', type);
    preview.events[type](replacement);
    assert.equal(replacement.prevented, true);
    assert.equal(input.value, '{"small":true}');
    assert.equal(input.hidden, false);
    assert.equal(preview.hidden, true);
    assert.equal(page.document.activeElement, input);
    assert.deepEqual(page.focusCalls.at(-1), { id: 'input', options: { preventScroll: true } });
    input.events.keydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
    await Promise.resolve();
    assert.equal(page.requests.at(-1).text, '{"small":true}');
  });
}

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
  page.get('input-view').events.paste(transfer('[]', 'paste'));
  assert.equal(page.document.activeElement, button);
  assert.equal(page.focusCalls.length, 1);
});

test('ordinary paste preserves native selection handling and does not refocus', () => {
  const page = setup();
  const input = page.get('input');
  input.value = '[0]';
  input.setSelectionRange(1, 2);
  input.focus();
  const event = transfer('1', 'paste');
  input.events.paste(event);
  assert.equal(event.prevented, false);
  assert.equal(input.value, '[0]');
  assert.equal(input.selectionStart, 1);
  assert.equal(input.selectionEnd, 2);
  assert.equal(page.document.activeElement, input);
  assert.equal(page.focusCalls.length, 1);
});

test('clearing a focused preview restores the textarea without refocusing unchanged modes', () => {
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
