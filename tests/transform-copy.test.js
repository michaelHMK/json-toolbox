import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskHandler } from '../src/worker/tasks.js';
import { loadPage } from './helpers/page-dom.js';

function setup(write = () => true) {
  const copied = [];
  const handler = createTaskHandler();
  const page = loadPage('transform', {
    bodyDataset: { action: 'unescape' },
    expose: '{ runTransform, doClear }',
    runTask: async (action, payload) => handler({ action, ...payload }),
    copyText: async (text) => { copied.push(text); return write(text); },
  });
  return { page, copied };
}

test('copy writes the empty unescaped result instead of the quoted source', async () => {
  const { page, copied } = setup();
  page.get('input').value = '""';
  await page.runTransform();
  await page.get('btn-copy').click();
  assert.deepEqual(copied, ['']);
  assert.equal(page.get('output-text').textContent, '');
  assert.equal(page.get('error').hidden, true);
  assert.equal(page.get('status').textContent, 'statusCopied');
});

test('a delayed clipboard response preserves newer copy feedback and parse errors', async () => {
  const writes = [];
  const { page } = setup(() => new Promise((resolve) => writes.push(resolve)));
  page.get('input').value = 'input';
  const first = page.get('btn-copy').click();
  const second = page.get('btn-copy').click();
  writes[1](false);
  await second;
  writes[0](true);
  await first;
  assert.equal(page.get('error').textContent, 'errCopyFailed');
  assert.equal(page.get('status').textContent, '');

  const third = page.get('btn-copy').click();
  page.get('input').value = '\\x';
  await page.runTransform();
  writes[2](true);
  await third;
  assert.match(page.get('error').textContent, /errUnescapeFailed/);
  assert.equal(page.get('status').textContent, '');
});

test('copy uses the displayed empty result after another transform fails', async () => {
  const { page, copied } = setup();
  page.get('input').value = '""';
  await page.runTransform();
  page.get('input').value = '\\x';
  page.get('input').events.input();
  await page.runTransform();
  assert.equal(page.get('error').hidden, false);
  await page.get('btn-copy').click();
  assert.deepEqual(copied, ['']);
});

test('copy falls back to input before a result exists, including after clear', async () => {
  const { page, copied } = setup();
  page.get('input').value = '""';
  await page.get('btn-copy').click();
  assert.deepEqual(copied, ['""']);
  await page.runTransform();
  page.doClear();
  await page.get('btn-copy').click();
  assert.equal(copied.length, 1);
  assert.equal(page.get('error').textContent, 'errNothingToCopy');
  page.get('input').value = '"next"';
  await page.get('btn-copy').click();
  assert.deepEqual(copied, ['""', '"next"']);
});
