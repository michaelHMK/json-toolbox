import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage } from './helpers/page-dom.js';
import { createTaskHandler } from '../src/worker/tasks.js';
import { createTaskRunner } from '../src/shared/worker-client.js';
import { LARGE_INPUT_THRESHOLD } from '../src/shared/text-input.js';

const settle = () => new Promise(setImmediate);
function setup(name) {
  const workers = [];
  let heldAction = null;
  const page = loadPage(name, {
    expose: name === 'formatter'
      ? '{ state, textInput, doFormat, setView, runSearch, doClear, getTree: () => treeView }'
      : '{ state, textInputs, doCompare, setCompareView, doClear, treeViews }',
    createTaskRunner(options) {
      return createTaskRunner({ ...options, createWorker() {
        const handle = createTaskHandler();
        const worker = {
          requests: [], terminated: false,
          terminate() { this.terminated = true; },
          postMessage(request) {
            this.requests.push(request);
            if (heldAction === request.action) return;
            queueMicrotask(() => {
              if (!this.terminated) this.onmessage({ data: structuredClone(handle(structuredClone(request))) });
            });
          },
          crash() { this.onerror({ message: 'test crash', preventDefault() {} }); },
        };
        workers.push(worker);
        return worker;
      } });
    },
  });
  return { page, workers, hold(action) { heldAction = action; } };
}

test('large formatter retains no UI object graph and restores windows and search after Worker reset', async () => {
  const { page, workers, hold } = setup('formatter');
  page.state.view = 'tree';
  page.textInput.setText(JSON.stringify({
    nested: { value: 'needle' }, rows: Array(4000).fill(1), padding: 'x'.repeat(LARGE_INPUT_THRESHOLD),
  }));
  await page.doFormat();
  await page.getTree().ready;
  assert.equal(page.state.remote, true);
  assert.equal(page.state.data, undefined);
  assert.equal(workers[0].requests.find((request) => request.action === 'format').includeData, false);
  await page.getTree().setOpen('/nested', true);
  await page.getTree().setOpen('/rows', true);
  assert.equal(page.state.expanded.has('/nested'), true);
  page.get('search').value = 'needle';
  await page.runSearch();
  await settle();
  assert.equal(page.state.matchCount, 1);
  assert.equal(page.get('tree').querySelector('.entry.current').dataset.path, '/nested/value');
  page.get('search').value = '';
  await page.runSearch();
  await settle();
  assert.equal(page.state.expanded.has('/nested'), true);

  hold('tree');
  page.get('tree').scrollTop = 40_000;
  page.getTree().refresh();
  await settle();
  page.get('btn-cancel').click();
  await settle();
  assert.equal(page.state.snapshotId, null);
  hold(null);
  page.getTree().refresh();
  await settle();
  assert.equal(workers.length, 2);
  assert.deepEqual(workers[1].requests.slice(0, 2).map((request) => request.action), ['parse', 'tree']);
  assert.equal(workers[1].requests[0].includeData, false);
  assert.equal(page.get('tree').querySelectorAll('.virtual-placeholder').length, 0);
  workers[1].crash();
  page.get('search').value = 'needle';
  await page.runSearch();
  await settle();
  assert.equal(workers.length, 3);
  assert.equal(page.state.data, undefined);
  assert.equal(page.state.matchCount, 1);
  await page.setView('text');
  await page.setView('tree');
  await settle();
  assert.equal(page.state.data, undefined);

  const previous = page.getTree();
  page.textInput.setText('{"small":true}');
  await page.doFormat();
  assert.equal(page.state.remote, false);
  assert.equal(page.state.data.small, true);
  assert.equal(previous.rowCount, 0);
  page.doClear();
});

test('large comparison preserves paired toggles, filters and snapshot navigation after cancellation', async () => {
  const { page, workers, hold } = setup('compare');
  const padding = 'x'.repeat(LARGE_INPUT_THRESHOLD);
  const left = { users: [{ id: 1, nested: { v: 1 } }, { id: 2, nested: { v: 2 } }], spare: { n: 1 }, padding };
  const right = { users: [{ id: 2, nested: { v: 2 } }, { id: 1, nested: { v: 3 } }], spare: { n: 1 }, padding };
  page.textInputs.left.setText(JSON.stringify(left));
  page.textInputs.right.setText(JSON.stringify(right));
  page.get('array-mode').value = 'key';
  page.get('key-field').value = 'id';
  await page.doCompare();
  await settle();
  assert.equal(page.state.remote, true);
  assert.equal(page.state.leftData, undefined);
  assert.equal(page.state.rightData, undefined);
  assert.equal(Object.hasOwn(page.state.result, 'leftData'), false);
  assert.equal(page.state.result.total, 1);
  assert.equal(page.get('tree-left').querySelector('.entry.current').dataset.path, '/users/0/nested/v');
  assert.equal(page.get('tree-right').querySelector('.entry.current').dataset.path, '/users/1/nested/v');
  const user = page.get('tree-left').querySelectorAll('.entry').find((entry) => entry.dataset.path === '/users/0');
  user.querySelector('.toggle').click();
  await settle();
  assert.equal(page.state.collapsed.left.has('/users/0'), true);
  assert.equal(page.state.collapsed.right.has('/users/1'), true);
  await page.treeViews.left.setOpen('/spare', true);
  page.get('only-diff').checked = true;
  page.get('only-diff').events.change();
  await settle();
  assert.equal(page.get('tree-left').querySelectorAll('.entry').some((row) => row.dataset.path === '/spare'), false);
  page.get('only-diff').checked = false;
  page.get('only-diff').events.change();
  await settle();
  assert.equal(page.get('tree-left').querySelectorAll('.entry').some((row) => row.dataset.path === '/spare/n'), true);
  await page.setCompareView('text');
  await page.setCompareView('struct');
  await settle();
  assert.equal(page.state.leftData, undefined);

  hold('tree');
  const pending = page.treeViews.left.setOpen('/spare', false);
  await settle();
  page.get('btn-cancel').click();
  await pending;
  hold(null);
  await page.treeViews.left.setOpen('/spare', true);
  await settle();
  assert.equal(workers.length, 2);
  assert.equal(workers[1].requests[0].action, 'diff');
  assert.equal(workers[1].requests[0].includeData, false);
  assert.equal(page.state.result.total, 1);
  assert.equal(page.state.result.pairs.length, 2);
  assert.equal(page.state.leftData, undefined);
  page.doClear();
  assert.equal(page.get('tree-left').children.length, 0);
  assert.equal(page.get('tree-right').children.length, 0);
});
