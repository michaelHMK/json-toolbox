import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTaskRunner } from '../src/shared/worker-client.js';
import { createTaskHandler } from '../src/worker/tasks.js';
import { createBusyFeedback } from '../src/shared/feedback.js';
import { loadPage, Element } from './helpers/page-dom.js';

const english = JSON.parse(readFileSync(new URL('../_locales/en/messages.json', import.meta.url)));
function translate(key, substitutions = []) {
  const entry = english[key];
  return entry.message.replace(/\$(\w+)\$/g, (_, name) =>
    substitutions[Number(entry.placeholders[name].content.slice(1)) - 1]);
}

function setup(name, action = 'minify') {
  const workers = [];
  let heldAction;
  const page = loadPage(name, {
    bodyDataset: { action },
    translate,
    expose: name === 'formatter' ? '{ state, doFormat, ensureTreeData, runSearch, doClear }'
      : name === 'compare' ? '{ state, doCompare, setCompareView, doClear }'
        : '{ runTransform, doClear, getOutput: () => outputText }',
    createTaskRunner(options) {
      return createTaskRunner({ ...options, createWorker() {
        const handle = createTaskHandler();
        const worker = {
          terminated: false,
          requests: [],
          terminate() { this.terminated = true; },
          postMessage(request) {
            this.requests.push(request);
            if (request.action === heldAction) return;
            this.complete(request);
          },
          complete(request) {
            queueMicrotask(() => {
              if (!this.terminated) this.onmessage({ data: handle(request) });
            });
          },
        };
        workers.push(worker);
        return worker;
      } });
    },
  });
  return { page, workers, hold(action) { heldAction = action; } };
}

test('busy exposes cancel after one second and hides it once all work settles', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const busyEl = new Element();
  const cancelEl = new Element();
  cancelEl.hidden = true;
  let cancelled = false;
  const update = createBusyFeedback({ busyEl, cancelEl, onCancel: () => { cancelled = true; } });
  update(true);
  context.mock.timers.tick(999);
  assert.equal(cancelEl.hidden, true);
  update(true);
  context.mock.timers.tick(1);
  assert.equal(cancelEl.hidden, false, 'queued work must not restart the delay');
  cancelEl.click();
  assert.equal(cancelled, true);
  update(false);
  assert.equal(busyEl.hidden, true);
  assert.equal(cancelEl.hidden, true);
  update(true);
  update(false);
  context.mock.timers.tick(1000);
  assert.equal(cancelEl.hidden, true);
});

test('formatter restores search data after cancellation and can format after a worker crash', async () => {
  const { page, workers, hold } = setup('formatter');
  page.get('input').value = '{"amount":1.20}';
  await page.doFormat();
  await page.ensureTreeData();
  page.get('search').value = '1.20';
  hold('search');
  const pending = page.runSearch();
  page.get('btn-cancel').click();
  await pending;
  assert.equal(workers[0].terminated, true);
  assert.equal(page.state.snapshotId, null);
  assert.equal(page.get('status').textContent, 'Cancelled');
  hold(null);
  await page.runSearch();
  assert.equal(workers.length, 2);
  assert.deepEqual(workers[1].requests.map((r) => r.action), ['parse', 'search']);
  assert.equal(page.state.matchCount, 1);
  workers[1].onerror({ message: 'crash', preventDefault() {} });
  await page.doFormat();
  assert.equal(workers.length, 3);
  assert.match(page.state.outputText, /1\.20/);
  page.doClear();
});

test('comparison restores lazy data and text after cancelling its snapshot worker', async () => {
  const { page, workers, hold } = setup('compare');
  await page.setCompareView('text');
  page.get('array-mode').value = 'key';
  page.get('key-field').value = 'id';
  page.get('input-left').value = '[{"id":1,"v":1},{"id":2,"v":2}]';
  page.get('input-right').value = '[{"id":2,"v":2},{"id":1,"v":9}]';
  hold('textDiff');
  const pending = page.doCompare();
  await new Promise(setImmediate);
  assert.equal(page.state.result.total, 1);
  page.get('btn-cancel').click();
  await pending;
  assert.equal(workers[0].terminated, true);
  hold(null);
  assert.equal(page.get('status').textContent, 'Cancelled');
  await page.setCompareView('struct');
  assert.equal(page.state.result.total, 1, 'rehydration must preserve the keyed comparison');
  assert.equal(page.state.result.pairs.length, 2);
  assert.equal(page.state.leftData[0].v, 1);
  await page.setCompareView('text');
  assert.ok(page.state.textResult);
  assert.equal(workers.length, 2);
  page.doClear();
});

test('search during a new format cannot restore an old document into the worker', async () => {
  const { page, workers, hold } = setup('formatter');
  page.state.view = 'tree';
  page.get('input').value = '{"amount":1}';
  await page.doFormat();
  page.get('search').value = '1';
  hold('search');
  const oldSearch = page.runSearch();
  page.get('btn-cancel').click();
  await oldSearch;

  page.get('input').value = '{"amount":2}';
  page.get('input').events.input();
  hold('format');
  const format = page.doFormat();
  const search = page.runSearch();
  assert.equal(await page.ensureTreeData(), false);
  hold(null);
  workers[1].complete(workers[1].requests[0]);
  await format;
  await search;
  await new Promise(setImmediate);
  assert.deepEqual(workers[1].requests.map((request) => request.action), ['format', 'search']);
  assert.equal(page.state.data.amount, 2);
  assert.equal(page.state.matchCount, 0, 'the displayed new document has no value 1');
  page.get('search').value = '2';
  await page.runSearch();
  assert.equal(page.state.matchCount, 1);
  page.doClear();
});

test('cancelled and invalid formats release the guard for searching the displayed document', async () => {
  const { page, workers, hold } = setup('formatter');
  page.state.view = 'tree';
  page.get('input').value = '{"amount":1}';
  await page.doFormat();
  page.get('search').value = '1';
  hold('format');
  page.get('input').value = '{"amount":2}';
  const pending = page.doFormat();
  await page.runSearch();
  page.get('btn-cancel').click();
  await pending;
  hold(null);
  await page.runSearch();
  assert.deepEqual(workers[1].requests.map((request) => request.action), ['parse', 'search']);
  assert.equal(page.state.matchCount, 1);
  page.get('input').value = '{';
  await page.doFormat();
  await page.runSearch();
  assert.equal(page.state.matchCount, 1);
  page.doClear();
});

test('view changes during a new comparison cannot restore the previous comparison snapshot', async () => {
  const { page, workers, hold } = setup('compare');
  await page.setCompareView('text');
  page.get('input-left').value = '{"old":1}';
  page.get('input-right').value = '{"old":2}';
  hold('textDiff');
  const old = page.doCompare();
  await new Promise(setImmediate);
  page.get('btn-cancel').click();
  await old;

  page.get('input-left').value = '{"fresh":10}';
  page.get('input-right').value = '{"fresh":20}';
  page.get('input-left').events.input();
  hold('diff');
  const pending = page.doCompare();
  await page.setCompareView('struct');
  await page.setCompareView('text');
  await page.setCompareView('struct');
  hold(null);
  workers[1].complete(workers[1].requests[0]);
  await pending;
  assert.deepEqual(workers[1].requests.map((request) => request.action), ['diff', 'comparisonData']);
  assert.equal(page.state.leftData.fresh, 10);
  assert.equal(page.state.rightData.fresh, 20);
  assert.equal(page.state.result.diffs[0].leftPath, '/fresh');
  await page.setCompareView('text');
  assert.deepEqual(JSON.parse(page.state.textResult.aText), { fresh: 10 });
  assert.deepEqual(JSON.parse(page.state.textResult.bText), { fresh: 20 });
  page.doClear();
});

test('swapping inputs cancels the first pending comparison before any result exists', async () => {
  const { page, workers, hold } = setup('compare');
  page.get('input-left').value = '{"value":1}';
  page.get('input-right').value = '{"value":2}';
  hold('diff');
  const pending = page.doCompare();
  page.get('btn-swap').click();
  await pending;
  assert.equal(workers[0].terminated, true);
  assert.equal(page.state.result, null);
  assert.equal(page.get('input-left').value, '{"value":2}');
  assert.equal(page.get('input-right').value, '{"value":1}');
  hold(null);
  await page.doCompare();
  assert.equal(page.state.leftData.value, 2);
  assert.equal(page.state.rightData.value, 1);
  page.doClear();
});

test('editing inputs cancels pending work on every page and permits a fresh operation', async () => {
  for (const [name, action, button, input] of [
    ['formatter', 'format', 'btn-format', 'input'],
    ['compare', 'diff', 'btn-compare', 'input-left'],
    ['transform', 'unescape', 'btn-run', 'input'],
  ]) {
    const { page, workers, hold } = setup(name, action);
    const source = name === 'transform' ? '"fresh"' : '{"fresh":1}';
    page.get(input).value = source;
    if (name === 'compare') page.get('input-right').value = '{}';
    hold(action);
    const pending = page.get(button).click();
    page.get(input).events.input();
    await pending;
    assert.equal(workers[0].terminated, true, name);
    hold(null);
    await page.get(button).click();
    assert.equal(workers.length, 2, name);
    assert.equal(page.get('error').hidden, true, name);
    page.doClear();
  }
});

test('English comparison errors localize the failure and focus the invalid right input', async () => {
  const { page } = setup('compare');
  page.get('input-left').value = '{"valid":1}';
  page.get('input-right').value = '{\n"a":tru}';
  await page.doCompare();
  assert.equal(page.get('error').textContent,
    'Compare failed: New (right): Line 2 column 8: Invalid JSON syntax.');
  assert.equal(page.get('input-right').focused, true);
  assert.equal(page.get('input-right').selectionStart, 9);
  assert.notEqual(page.get('input-left').focused, true);
  page.doClear();
});

test('unescape accepts quoted input and localizes errors at the original position', async () => {
  const { page } = setup('transform', 'unescape');
  page.get('input').value = JSON.stringify('{"a":1}');
  await page.runTransform();
  assert.equal(page.getOutput(), '{"a":1}');
  page.get('input').value = '\\x';
  await page.runTransform();
  assert.equal(page.get('error').textContent, 'Unescape failed: Line 1 column 2: Invalid escaped string.');
  assert.equal(page.get('input').selectionStart, 1);
  page.doClear();
});
