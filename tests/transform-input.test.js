import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskHandler } from '../src/worker/tasks.js';
import { LARGE_INPUT_THRESHOLD } from '../src/shared/text-input.js';
import { loadPage } from './helpers/page-dom.js';

const largeText = '原文 "first"\n' + 'x'.repeat(LARGE_INPUT_THRESHOLD + 1) + '\nlast';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function transfer(text) {
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  event.clipboardData = { types: ['text/plain'], getData: () => text };
  return event;
}

function setup(action, runTask) {
  const copied = [];
  const requests = [];
  const handler = createTaskHandler();
  let importOptions;
  const page = loadPage('transform', {
    bodyDataset: { action },
    expose: '{ textInput, runTransform, doClear, getOutput: () => outputText }',
    runTask: runTask || (async (task, payload) => {
      requests.push({ action: task, ...payload });
      return handler({ action: task, ...payload });
    }),
    createFileImport(options) {
      importOptions = options;
      return { reset() {} };
    },
    copyText: async (text) => { copied.push(text); return true; },
  });
  return { ...page, copied, requests, importText: (text) => importOptions.onImport({ text }) };
}

for (const action of ['escape', 'unescape']) {
  const source = action === 'escape' ? largeText : JSON.stringify(largeText);
  const expected = action === 'escape' ? JSON.stringify(largeText).slice(1, -1) : largeText;

  test(`${action} runs from the large editor and copies the complete source or result`, async () => {
    const page = setup(action);
    const input = page.get('input');
    const host = page.get('input-editor');
    const paste = transfer(source);
    input.events.paste(paste);
    assert.equal(paste.prevented, true);
    assert.equal(input.hidden, true);
    assert.equal(input.value, '');
    assert.equal(host.hidden, false);
    assert.equal(page.textInput.getText(), source);
    await page.get('btn-copy').click();
    assert.equal(page.copied.at(-1), source);

    host.events.keydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
    await flush();
    assert.equal(page.requests.at(-1).action, action);
    assert.equal(page.requests.at(-1).text, source);
    assert.equal(page.getOutput(), expected);
    await page.get('btn-copy').click();
    assert.equal(page.copied.at(-1), expected);

    const small = action === 'escape' ? 'small\ntext' : '"small\\ntext"';
    host.editor.replace(0, host.editor.length, small);
    assert.equal(page.textInput.getText(), small);
    host.events.keydown({ key: 'Enter', metaKey: true, preventDefault() {} });
    await flush();
    assert.equal(page.requests.at(-1).text, small);
    assert.equal(page.getOutput(), action === 'escape' ? 'small\\ntext' : 'small\ntext');
    page.doClear();
    assert.equal(page.textInput.getText(), '');
    assert.equal(host.hidden, true);
    assert.equal(page.get('output-text').textContent, '');
  });

  test(`${action} large imports retain the original source and complete automatic conversion`, async () => {
    const page = setup(action);
    page.importText(source);
    assert.equal(page.get('input').hidden, true);
    assert.equal(page.get('input').value, '');
    assert.equal(page.get('input-editor').hidden, false);
    assert.equal(page.textInput.getText(), source);
    await flush();
    assert.deepEqual(page.requests.map((request) => request.action), ['clear', action]);
    assert.equal(page.requests.at(-1).text, source);
    assert.equal(page.getOutput(), expected);
  });

  test(`${action} replacing large input and clearing isolate late transform results`, async () => {
    let finish;
    let cancellations = 0;
    const runTask = Object.assign((task) => task === action
      ? new Promise((resolve) => { finish = resolve; })
      : Promise.resolve({ ok: true, result: {} }), {
      cancel() { cancellations++; },
    });
    const page = setup(action, runTask);
    page.get('input').value = 'old';
    page.get('input').setSelectionRange(0, 3);
    const oldRun = page.runTransform();
    const previousCancellations = cancellations;
    page.get('input').events.paste(transfer(source));
    assert.equal(cancellations, previousCancellations + 1);
    finish({ ok: true, result: { text: 'stale output' }, duration: 1 });
    await oldRun;
    assert.equal(page.getOutput(), '');
    assert.equal(page.textInput.getText(), source);

    const pending = page.runTransform();
    page.doClear();
    finish({ ok: true, result: { text: 'cleared output' }, duration: 1 });
    await pending;
    assert.equal(page.getOutput(), '');
    assert.equal(page.textInput.getText(), '');
    assert.equal(page.get('input-editor').hidden, true);
  });
}

test('unescape selects the invalid character in the editable large input', async () => {
  const page = setup('unescape');
  const source = 'line\n'.repeat(Math.ceil(LARGE_INPUT_THRESHOLD / 5)) + '\\x';
  page.get('input').events.paste(transfer(source));
  await page.runTransform();
  const host = page.get('input-editor');
  assert.equal(page.textInput.getText(), source);
  assert.equal(host.hidden, false);
  assert.equal(host.focused, true);
  assert.equal(host.selectionStart, source.length - 1);
  assert.equal(host.value.slice(host.selectionStart, host.selectionEnd), 'x');
  assert.equal(page.get('error').hidden, false);
});
