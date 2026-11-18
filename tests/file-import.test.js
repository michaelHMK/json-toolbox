import test from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import {
  MAX_FILE_SIZE, createFileImport, formatFileSize, readJsonFile,
} from '../src/shared/file-import.js';
import { Element, loadPage } from './helpers/page-dom.js';
import { LARGE_INPUT_THRESHOLD } from '../src/shared/text-input.js';

const encoder = new TextEncoder();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
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

function importPage(action, runTask) {
  let importOptions;
  let resets = 0;
  const page = loadPage(action === 'format' ? 'formatter' : 'transform', {
    bodyDataset: { action },
    runTask,
    createFileImport(options) {
      importOptions = options;
      return { reset() { resets++; } };
    },
    expose: action === 'format'
      ? '{ state, textInput, doClear, doFormat, fillSample }'
      : '{ textInput, doClear, getOutput: () => outputText }',
  });
  return { page, importText: (text) => importOptions.onImport({ text }), get resets() { return resets; } };
}

test('formatter imports original text and formats even when paste formatting is disabled', async () => {
  const actions = [];
  const { page, importText } = importPage('format', async (action, payload) => {
    actions.push({ action, payload });
    if (action === 'format') return {
      ok: true,
      result: { text: '{\n  "picked": true\n}', data: { picked: true } },
      duration: 1,
    };
    return { ok: true, result: {} };
  });
  page.get('auto-format').checked = false;
  importText('{"picked":true}');
  await flush();
  assert.deepEqual(actions.map(({ action }) => action), ['clear', 'format']);
  assert.equal(actions[1].payload.text, '{"picked":true}');
  assert.equal(page.get('input').value, '{"picked":true}');
  assert.equal(page.state.outputText, '{\n  "picked": true\n}');
});

test('formatter clear, sample and manual editing reset file import state', async () => {
  const imported = importPage('format', async (action) => action === 'format'
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
  const { page, importText } = importPage('format', (action, payload) => {
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
  importText('{"new":true}');
  await flush();
  finishOld({ ok: true, result: { text: '{"old":true}', data: { old: true } }, duration: 1 });
  await oldFormat;
  assert.equal(page.state.outputText, '{\n  "new": true\n}');
  assert.equal(page.get('input').value, '{"new":true}');
});

for (const { action, source, output } of [
  { action: 'minify', source: '{ "a": 1 }', output: '{"a":1}' },
  { action: 'escape', source: '{ "text": "中文" }', output: String.raw`{ \"text\": \"中文\" }` },
  { action: 'unescape', source: '"line\\n中文"', output: 'line\n中文' },
]) {
  test(`${action} imports the original source and automatically runs once`, async () => {
    const actions = [];
    const { page, importText } = importPage(action, async (task, payload) => {
      actions.push({ action: task, payload });
      if (task === action) return { ok: true, result: { text: output }, duration: 1 };
      return { ok: true, result: {} };
    });
    importText(source);
    await flush();
    assert.deepEqual(actions.map(({ action }) => action), ['clear', action]);
    assert.equal(actions[1].payload.text, source);
    assert.equal(page.textInput.getText(), source);
    assert.equal(page.get('input').value, source);
    assert.equal(page.getOutput(), output);
  });

  test(`${action} clear, sample and manual editing reset file import state`, async () => {
    const imported = importPage(action, async (task) => task === action
      ? { ok: true, result: { text: output }, duration: 0 }
      : { ok: true, result: {} });
    imported.page.doClear();
    imported.page.get('btn-sample').click();
    imported.page.get('input').events.input();
    await flush();
    assert.equal(imported.resets, 3);
  });
}

test('large formatter imports keep the original file text and label until the first edit', async () => {
  const source = '{\r\n  "payload": "' + 'x'.repeat(LARGE_INPUT_THRESHOLD + 1) + '"\r\n}';
  const actions = [];
  let finish;
  const formatted = new Promise((resolve) => { finish = resolve; });
  const page = loadPage('formatter', {
    expose: '{ textInput }',
    createFileImport,
    runTask: async (action, payload) => {
      actions.push({ action, payload });
      if (action === 'format') {
        finish();
        return { ok: true, result: { text: '{"payload":"formatted"}' }, duration: 1 };
      }
      return { ok: true, result: {} };
    },
  });
  const picker = page.get('file-input');
  const file = jsonFile(source);
  picker.files = [file];
  picker.events.change();
  await formatted;

  const host = page.get('input-editor');
  assert.equal(page.get('input').hidden, true);
  assert.equal(page.get('input').value, '');
  assert.equal(host.hidden, false);
  assert.equal(page.textInput.getText(), source);
  assert.deepEqual(actions.map(({ action }) => action), ['clear', 'format']);
  assert.equal(actions[1].payload.text, source);
  assert.equal(actions[1].payload.retainSnapshot, false);
  assert.equal(actions[1].payload.retainSearch, false);
  const fileName = page.get('file-name');
  assert.equal(fileName.textContent, 'data.json · ' + formatFileSize(file.size));
  assert.equal(fileName.hidden, false);

  host.editor.replace(0, 0, ' ');
  assert.equal(page.textInput.getText(), ' ' + source.replaceAll('\r\n', '\n'));
  assert.equal(fileName.hidden, true);
});

for (const action of ['format', 'minify']) {
  test(`${action} selects the original CRLF parse error in the large editor`, async () => {
    const prefix = '[\r\n  "' + 'x'.repeat(LARGE_INPUT_THRESHOLD) + '",\r\n';
    const source = prefix + '  INVALID_TOKEN,\r\n  1\r\n]';
    const position = prefix.length + 2;
    const { page, importText } = importPage(action, async (task) => task === action ? {
      ok: false, error: 'Invalid JSON token', position, line: 3, column: 3,
    } : { ok: true, result: {} });
    importText(source);
    await flush();
    const host = page.get('input-editor');
    assert.equal(page.get('input').hidden, true);
    assert.equal(host.hidden, false);
    assert.equal(host.focused, true);
    assert.equal(page.textInput.getText(), source);
    assert.equal(host.selectionStart, host.value.indexOf('INVALID_TOKEN'));
    assert.equal(host.value.slice(host.selectionStart, host.selectionEnd), 'I');
    assert.equal(page.get('error').hidden, false);
    assert.match(page.get('error').textContent, /Invalid JSON token/);
  });

  test(`${action} retains native selection and scrolling for small parse errors`, async () => {
    const source = '{\n "a": 1,\n "b": 2,\n "c": invalid\n}';
    const position = source.indexOf('invalid');
    const { page, importText } = importPage(action, async (task) => task === action ? {
      ok: false, error: 'Invalid JSON token', position, line: 4, column: 7,
    } : { ok: true, result: {} });
    importText(source);
    await flush();
    const input = page.get('input');
    assert.equal(input.hidden, false);
    assert.equal(input.value, source);
    assert.equal(input.focused, true);
    assert.equal(input.selectionStart, position);
    assert.equal(input.selectionEnd, position + 1);
    assert.equal(input.scrollTop, 21);
    assert.equal(page.get('input-editor').hidden, true);
    assert.equal(page.selection.ranges.length, 0);
  });
}

test('large minify imports use the large editor without affecting the original source', async () => {
  const source = '{ "payload": "' + 'x'.repeat(LARGE_INPUT_THRESHOLD + 1) + '" }';
  let taskText = '';
  const { page, importText } = importPage('minify', async (action, payload) => {
    if (action === 'minify') {
      taskText = payload.text;
      return { ok: true, result: { text: '{"payload":"minified"}' }, duration: 1 };
    }
    return { ok: true, result: {} };
  });
  importText(source);
  await flush();
  assert.equal(taskText, source);
  assert.equal(page.getOutput(), '{"payload":"minified"}');
  assert.equal(page.get('input').hidden, true);
  assert.equal(page.get('input-editor').hidden, false);
});

function comparisonImportPage(runTask) {
  const imports = [];
  const page = loadPage('compare', {
    expose: '{ textInputs, doSwap, doClear }',
    runTask,
    createFileImport: (options) => { imports.push(options); return { reset() {} }; },
  });
  return { page, imports };
}

test('comparison moves large and small input to the appropriate editors on swap', () => {
  const { page, imports } = comparisonImportPage();
  const text = '"' + 'x'.repeat(LARGE_INPUT_THRESHOLD + 1) + '"';
  imports[0].onImport({ text });
  assert.equal(page.textInputs.left.getText(), text);
  assert.equal(page.get('input-left').value, '');
  assert.equal(page.get('input-editor-left').hidden, false);
  page.get('input-right').value = '{}';
  page.doSwap();
  assert.equal(page.textInputs.right.getText(), text);
  assert.equal(page.get('input-editor-right').hidden, false);
  assert.equal(page.textInputs.left.getText(), '{}');
  assert.equal(page.get('input-editor-left').hidden, true);
  page.doClear();
  assert.equal(page.textInputs.right.getText(), '');
  assert.equal(page.get('input-editor-right').hidden, true);
});

test('clearing or editing after file import supersedes the deferred automatic comparison', async () => {
  for (const action of ['clear', 'edit']) {
    const requests = [];
    const { page, imports } = comparisonImportPage(async (name) => {
      requests.push(name);
      return { ok: true, result: {} };
    });
    imports[0].onImport({ text: '{"a":1}' });
    imports[1].onImport({ text: '{"a":2}' });
    if (action === 'clear') page.doClear();
    else {
      page.get('input-left').value = '{"new":3}';
      page.get('input-left').events.input();
    }
    await flush();
    assert.ok(!requests.includes('diff'), 'stale file import must not start a new comparison');
  }
});

test('clearing a deferred large file import prevents its page from restarting', async () => {
  for (const action of ['format', 'minify', 'escape', 'unescape']) {
    const requests = [];
    const { page, importText } = importPage(action, async (name) => {
      requests.push(name);
      return { ok: true, result: {} };
    });
    importText('"' + 'x'.repeat(LARGE_INPUT_THRESHOLD + 1) + '"');
    page.doClear();
    await flush();
    assert.ok(!requests.includes(action));
    assert.equal(page.get('input').value, '');
    assert.equal(page.get('input-editor').hidden, true);
  }
});
