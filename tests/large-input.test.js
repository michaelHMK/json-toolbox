import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage } from './helpers/page-dom.js';
import { createTaskHandler } from '../src/worker/tasks.js';
import { LARGE_INPUT_THRESHOLD } from '../src/shared/text-input.js';

const largeText = () => '"' + 'x'.repeat(LARGE_INPUT_THRESHOLD + 1) + '"';
function transfer(text, type = 'paste') {
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  event[type === 'paste' ? 'clipboardData' : 'dataTransfer'] = { types: ['text/plain'], getData: () => text };
  return event;
}

test('large paste preserves native insertion selection without assigning the combined text to textarea', () => {
  const page = loadPage('formatter', { expose: '{ textInput }' });
  const input = page.get('input');
  input.value = '[0]'; input.selectionStart = 1; input.selectionEnd = 2;
  const text = largeText();
  const event = transfer(text);
  input.events.paste(event);
  assert.equal(event.prevented, true);
  assert.equal(page.textInput.getText(), '[' + text + ']');
  assert.equal(input.value, '');
  assert.equal(input.hidden, true);
  assert.ok(page.get('input-view').textContent.length < 10000);
  const replacement = transfer('{"small":true}');
  page.get('input-view').events.paste(replacement);
  assert.equal(replacement.prevented, true);
  assert.equal(input.value, '{"small":true}');
  assert.equal(input.hidden, false);
});

test('large plain-text drop uses virtual input and a file drop remains available to the file importer', () => {
  const page = loadPage('formatter', { expose: '{ textInput }' });
  const event = transfer(largeText(), 'drop');
  page.get('input').events.drop(event);
  assert.equal(event.prevented, true);
  assert.equal(page.textInput.isLarge(), true);
  const file = transfer('ignored', 'drop'); file.dataTransfer.types.push('Files');
  page.get('input-view').events.drop(file);
  assert.equal(file.prevented, false);
});

test('comparison imports, swaps and clears virtual input without losing original source', async () => {
  const imports = [];
  const handle = createTaskHandler();
  const page = loadPage('compare', {
    expose: '{ textInputs, doSwap, doClear, state }',
    runTask: async (action, payload) => handle({ action, ...payload }),
    createFileImport: (options) => { imports.push(options); return { reset() {} }; },
  });
  const text = largeText();
  imports[0].onImport({ text });
  assert.equal(page.textInputs.left.getText(), text);
  assert.equal(page.get('input-left').value, '');
  assert.equal(page.get('input-view-left').hidden, false);
  page.get('input-right').value = '{}';
  page.doSwap();
  assert.equal(page.textInputs.right.getText(), text);
  assert.equal(page.textInputs.left.getText(), '{}');
  page.doClear();
  assert.equal(page.textInputs.right.getText(), '');
  assert.equal(page.get('input-view-right').hidden, true);
});

test('clearing or editing after file import supersedes the deferred automatic comparison', async () => {
  for (const action of ['clear', 'edit']) {
    const imports = [];
    const requests = [];
    const page = loadPage('compare', {
      expose: '{ doClear }',
      runTask: async (name) => { requests.push(name); return { ok: true, result: {} }; },
      createFileImport: (options) => { imports.push(options); return { reset() {} }; },
    });
    imports[0].onImport({ text: '{"a":1}' });
    imports[1].onImport({ text: '{"a":2}' });
    if (action === 'clear') page.doClear();
    else {
      page.get('input-left').value = '{"new":3}';
      page.get('input-left').events.input();
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(!requests.includes('diff'), 'stale file import must not start a new comparison');
  }
});

test('clearing a deferred large file import prevents formatter and minifier from restarting', async () => {
  for (const action of ['format', 'minify']) {
    let importer;
    const requests = [];
    const page = loadPage(action === 'format' ? 'formatter' : 'transform', {
      expose: '{ doClear }', bodyDataset: { action },
      runTask: async (name) => { requests.push(name); return { ok: true, result: {} }; },
      createFileImport: (options) => { importer = options; return { reset() {} }; },
    });
    importer.onImport({ text: largeText() });
    page.doClear();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(!requests.includes(action));
    assert.equal(page.get('input').value, '');
    assert.equal(page.get('input-view').hidden, true);
  }
});
