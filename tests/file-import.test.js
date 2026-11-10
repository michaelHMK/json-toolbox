import test from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import {
  MAX_FILE_SIZE, createFileImport, formatFileSize, readJsonFile,
} from '../src/shared/file-import.js';
import { Element, loadPage } from './helpers/page-dom.js';

const encoder = new TextEncoder();
const flush = () => new Promise((resolve) => setImmediate(resolve));
const jsonFile = (text, name = 'data.json') => new File([text], name, { type: 'text/plain' });

async function expectKey(promise, key) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.key, key);
    return true;
  });
}

function setupImport() {
  const dropZone = new Element();
  const fileInput = new Element('input');
  const triggerEl = new Element('button');
  const fileNameEl = new Element();
  const dropHint = new Element();
  triggerEl.textContent = 'Import file';
  fileNameEl.hidden = true;
  dropHint.hidden = true;
  const imported = [];
  const errors = [];
  let pickerClicks = 0;
  fileInput.click = () => { pickerClicks++; };
  const controller = createFileImport({
    dropZone, fileInput, triggerEl, fileNameEl, dropHint,
    onImport: (file) => imported.push(file),
    onError: (message) => errors.push(message),
  });
  return {
    dropZone, fileInput, triggerEl, fileNameEl, dropHint,
    imported, errors, controller,
    get pickerClicks() { return pickerClicks; },
  };
}

function dragEvent(files = []) {
  return {
    dataTransfer: { types: ['Files'], files },
    prevented: false,
    preventDefault() { this.prevented = true; },
  };
}

test('JSON file reading preserves Unicode and escapes and removes only the leading BOM', async () => {
  const source = '\uFEFF{"text":"中文😀","line":"a\\r\\nb","inner":"\uFEFF"}';
  const result = await readJsonFile(jsonFile(source, 'DATA.JSON'));
  assert.equal(result.name, 'DATA.JSON');
  assert.equal(result.text, source.slice(1));
  assert.equal(result.size, jsonFile(source).size);
});

test('file sizes use binary units with at most one decimal', () => {
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(1023), '1023 B');
  assert.equal(formatFileSize(1024), '1 KiB');
  assert.equal(formatFileSize(1536), '1.5 KiB');
  assert.equal(formatFileSize(MAX_FILE_SIZE), '50 MiB');
});

test('only .json filenames are accepted regardless of MIME type', async () => {
  for (const name of ['data.txt', 'data.jsonl', 'data.ndjson', 'data', 'data.zip']) {
    await expectKey(readJsonFile(jsonFile('{}', name)), 'errFileType');
  }
});

test('the exact size limit is accepted and larger files are rejected before reading', async () => {
  const exact = {
    name: 'exact.json',
    size: MAX_FILE_SIZE,
    arrayBuffer: async () => encoder.encode('{}').buffer,
  };
  assert.equal((await readJsonFile(exact)).text, '{}');
  let read = false;
  const oversized = {
    name: 'large.json',
    size: MAX_FILE_SIZE + 1,
    arrayBuffer: async () => {
      read = true;
      return encoder.encode('{}').buffer;
    },
  };
  await expectKey(readJsonFile(oversized), 'errFileTooLarge');
  assert.equal(read, false);
});

test('zero-byte and whitespace-only files are empty', async () => {
  await expectKey(readJsonFile(jsonFile('', 'empty.json')), 'errFileEmpty');
  await expectKey(readJsonFile(jsonFile(' \t\r\n', 'blank.json')), 'errFileEmpty');
  await expectKey(readJsonFile(jsonFile('\uFEFF \n', 'bom.json')), 'errFileEmpty');
});

test('invalid UTF-8 is rejected instead of replacing bytes', async () => {
  const invalid = new File([new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d])], 'bad.json');
  await expectKey(readJsonFile(invalid), 'errFileEncoding');
});

test('file read failures retain their filename and cause', async () => {
  const file = {
    name: 'denied.json',
    size: 2,
    arrayBuffer: async () => { throw new Error('Permission denied'); },
  };
  await assert.rejects(readJsonFile(file), (error) => {
    assert.equal(error.key, 'errFileRead');
    assert.deepEqual(error.substitutions, ['denied.json', 'Permission denied']);
    return true;
  });
});

test('picker imports the same file repeatedly and restores the button state', async () => {
  const page = setupImport();
  page.triggerEl.click();
  assert.equal(page.pickerClicks, 1);
  for (let i = 0; i < 2; i++) {
    page.fileInput.files = [jsonFile('{"picked":true}')];
    page.fileInput.events.change();
    await flush();
    assert.equal(page.imported.length, i + 1);
    assert.equal(page.imported[i].text, '{"picked":true}');
    assert.equal(page.fileInput.value, '');
  }
  assert.equal(page.fileNameEl.hidden, false);
  assert.match(page.fileNameEl.textContent, /^data\.json · \d+ B$/);
  assert.equal(page.triggerEl.disabled, false);
  assert.equal(page.triggerEl.textContent, 'Import file');
  assert.equal(page.triggerEl.getAttribute('aria-busy'), null);
});

test('validation errors preserve the previous document label', async () => {
  const page = setupImport();
  page.dropZone.events.drop(dragEvent([jsonFile('{"keep":true}', 'keep.json')]));
  await flush();
  const label = page.fileNameEl.textContent;
  page.dropZone.events.drop(dragEvent([jsonFile('{}', 'bad.txt')]));
  await flush();
  assert.deepEqual(page.errors, ['errFileType']);
  assert.equal(page.imported.length, 1);
  assert.equal(page.fileNameEl.textContent, label);
});

test('dropping multiple files imports none of them', async () => {
  const page = setupImport();
  const event = dragEvent([jsonFile('{}', 'a.json'), jsonFile('[]', 'b.json')]);
  page.dropZone.events.drop(event);
  await flush();
  assert.equal(event.prevented, true);
  assert.deepEqual(page.errors, ['errFileMultiple']);
  assert.equal(page.imported.length, 0);
  assert.equal(page.dropHint.hidden, true);
});

test('nested drag events keep the hint visible until the pane is left', () => {
  const page = setupImport();
  page.dropZone.events.dragenter(dragEvent());
  page.dropZone.events.dragenter(dragEvent());
  page.dropZone.events.dragover(dragEvent());
  assert.equal(page.dropHint.hidden, false);
  assert.equal(page.dropZone.classList.contains('is-dragging'), true);
  page.dropZone.events.dragleave(dragEvent());
  assert.equal(page.dropHint.hidden, false);
  page.dropZone.events.dragleave(dragEvent());
  assert.equal(page.dropHint.hidden, true);
  assert.equal(page.dropZone.classList.contains('is-dragging'), false);
});

test('the latest drop wins when file reads finish out of order', async () => {
  const page = setupImport();
  let finishFirst;
  const first = {
    name: 'first.json',
    size: 2,
    arrayBuffer: () => new Promise((resolve) => { finishFirst = resolve; }),
  };
  page.dropZone.events.drop(dragEvent([first]));
  page.dropZone.events.drop(dragEvent([jsonFile('{"second":true}', 'second.json')]));
  await flush();
  finishFirst(encoder.encode('{"first":true}').buffer);
  await flush();
  assert.deepEqual(page.imported.map((file) => file.name), ['second.json']);
  assert.match(page.fileNameEl.textContent, /^second\.json/);
  assert.equal(page.triggerEl.disabled, false);
});

test('reset invalidates a pending read and clears import UI', async () => {
  const page = setupImport();
  let finishRead;
  const file = {
    name: 'pending.json',
    size: 2,
    arrayBuffer: () => new Promise((resolve) => { finishRead = resolve; }),
  };
  page.dropZone.events.drop(dragEvent([file]));
  assert.equal(page.triggerEl.disabled, true);
  page.controller.reset();
  assert.equal(page.triggerEl.disabled, false);
  assert.equal(page.fileNameEl.hidden, true);
  finishRead(encoder.encode('{}').buffer);
  await flush();
  assert.equal(page.imported.length, 0);
});

function formatterImportPage(runTask) {
  let importOptions;
  let resets = 0;
  const page = loadPage('formatter', {
    runTask,
    createFileImport(options) {
      importOptions = options;
      return { reset() { resets++; } };
    },
    expose: '{ state, doClear, doFormat, fillSample }',
  });
  return { page, importOptions, get resets() { return resets; } };
}

test('formatter imports original text and formats even when paste formatting is disabled', async () => {
  const actions = [];
  const { page, importOptions } = formatterImportPage(async (action, payload) => {
    actions.push({ action, payload });
    if (action === 'format') return {
      ok: true,
      result: { text: '{\n  "picked": true\n}', data: { picked: true } },
      duration: 1,
    };
    return { ok: true, result: {} };
  });
  page.get('auto-format').checked = false;
  importOptions.onImport({ text: '{"picked":true}' });
  await flush();
  assert.deepEqual(actions.map(({ action }) => action), ['clear', 'format']);
  assert.equal(actions[1].payload.text, '{"picked":true}');
  assert.equal(page.get('input').value, '{"picked":true}');
  assert.equal(page.state.outputText, '{\n  "picked": true\n}');
});

test('formatter clear, sample and manual editing reset file import state', async () => {
  const imported = formatterImportPage(async (action) => action === 'format'
    ? { ok: true, result: { text: '{}', data: {} }, duration: 0 }
    : { ok: true, result: {} });
  imported.page.doClear();
  imported.page.fillSample();
  imported.page.get('input').events.input();
  await flush();
  assert.equal(imported.resets, 3);
});

test('a stale format response cannot overwrite an imported document', async () => {
  let finishOld;
  const { page, importOptions } = formatterImportPage((action, payload) => {
    if (action === 'format' && payload.text === '{"old":true}') {
      return new Promise((resolve) => { finishOld = resolve; });
    }
    if (action === 'format') return Promise.resolve({
      ok: true,
      result: { text: '{\n  "new": true\n}', data: { new: true } },
      duration: 1,
    });
    return Promise.resolve({ ok: true, result: {} });
  });
  page.get('input').value = '{"old":true}';
  const oldFormat = page.doFormat();
  importOptions.onImport({ text: '{"new":true}' });
  await flush();
  finishOld({ ok: true, result: { text: '{"old":true}', data: { old: true } }, duration: 1 });
  await oldFormat;
  assert.equal(page.state.outputText, '{\n  "new": true\n}');
  assert.equal(page.get('input').value, '{"new":true}');
});

test('minify imports and runs once while other transform pages do not bind import', async () => {
  const actions = [];
  let importOptions;
  const page = loadPage('transform', {
    bodyDataset: { action: 'minify' },
    runTask: async (action, payload) => {
      actions.push({ action, payload });
      if (action === 'minify') return { ok: true, result: { text: '{"a":1}' }, duration: 1 };
      return { ok: true, result: {} };
    },
    createFileImport(options) {
      importOptions = options;
      return { reset() {} };
    },
    expose: '{ getOutput: () => outputText }',
  });
  importOptions.onImport({ text: '{ "a": 1 }' });
  await flush();
  assert.deepEqual(actions.map(({ action }) => action), ['clear', 'minify']);
  assert.equal(actions[1].payload.text, '{ "a": 1 }');
  assert.equal(page.getOutput(), '{"a":1}');

  let created = false;
  loadPage('transform', {
    bodyDataset: { action: 'escape' },
    createFileImport() { created = true; return { reset() {} }; },
    expose: '{}',
  });
  assert.equal(created, false);
});

test('large formatter imports use virtual input and release document caches', async () => {
  const source = '{"payload":"' + 'x'.repeat(2 * 1024 * 1024 + 1) + '"}';
  const actions = [];
  const imported = formatterImportPage(async (action, payload) => {
    actions.push({ action, payload });
    if (action === 'format') return { ok: true, result: { text: '{"payload":"formatted"}' }, duration: 1 };
    return { ok: true, result: {} };
  });
  imported.importOptions.onImport({ text: source });
  await flush();
  assert.equal(imported.page.get('input').hidden, true);
  assert.equal(imported.page.get('input-view').hidden, false);
  assert.equal(actions[1].payload.text, source);
  assert.equal(actions[1].payload.retainSnapshot, false);
  assert.equal(actions[1].payload.retainSearch, false);
});

test('large parse errors restore editable input for source location feedback', async () => {
  const source = '{"payload":"' + 'x'.repeat(2 * 1024 * 1024 + 1) + '"';
  const imported = formatterImportPage(async (action) => {
    if (action === 'format') return { ok: false, error: 'Unexpected end of JSON input', position: source.length - 1 };
    return { ok: true, result: {} };
  });
  imported.importOptions.onImport({ text: source });
  await flush();
  assert.equal(imported.page.get('input').hidden, false);
  assert.equal(imported.page.get('input').value, source);
  assert.equal(imported.page.get('input-view').hidden, true);
  assert.equal(imported.page.get('error').hidden, false);
});

test('large minify imports use virtual input without affecting the original source', async () => {
  const source = '{ "payload": "' + 'x'.repeat(2 * 1024 * 1024 + 1) + '" }';
  let importOptions;
  let taskText = '';
  const page = loadPage('transform', {
    bodyDataset: { action: 'minify' },
    runTask: async (action, payload) => {
      if (action === 'minify') {
        taskText = payload.text;
        return { ok: true, result: { text: '{"payload":"minified"}' }, duration: 1 };
      }
      return { ok: true, result: {} };
    },
    createFileImport(options) { importOptions = options; return { reset() {} }; },
    expose: '{ getOutput: () => outputText }',
  });
  importOptions.onImport({ text: source });
  await flush();
  assert.equal(taskText, source);
  assert.equal(page.getOutput(), '{"payload":"minified"}');
  assert.equal(page.get('input').hidden, true);
  assert.equal(page.get('input-view').hidden, false);
});
