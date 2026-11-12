// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node bench/tree-view.mjs
// Starts a temporary local server. Optional: BENCH_BASE_URL and CHROMIUM_EXECUTABLE.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(process.cwd());
const server = process.env.BENCH_BASE_URL ? null : createServer(async (request, response) => {
  try {
    const file = resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
    if (!file.startsWith(root + '/')) throw new Error('Invalid path');
    response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' })[extname(file)] || 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
if (server) await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = process.env.BENCH_BASE_URL || `http://127.0.0.1:${server.address().port}`;
let browser;
let page;
const errors = [];
const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function selectedRows() {
  await settle();
  return page.evaluate(() => ['left', 'right'].map((side) => {
    const host = document.getElementById('tree-' + side);
    const entry = host.querySelector('.entry.current');
    const box = host.getBoundingClientRect();
    const current = entry?.getBoundingClientRect();
    return {
      side, path: entry?.dataset.path, text: entry?.textContent,
      visible: !!current && current.top >= box.top && current.bottom <= box.bottom,
      scrollTop: host.scrollTop, entries: host.querySelectorAll('.entry').length,
    };
  }));
}

async function selectedTextBounds(ids) {
  await settle();
  return page.evaluate((ids) => ids.map((id) => {
    const host = document.getElementById(id);
    const entry = host.querySelector('.entry.current');
    const box = host.getBoundingClientRect();
    const left = box.left + host.clientLeft;
    const right = left + host.clientWidth;
    const text = [...entry.querySelectorAll('.key, .v')].map((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const rect = range.getBoundingClientRect();
      return {
        text: element.textContent, left: rect.left, right: rect.right,
        visible: rect.left >= left && rect.right <= right && rect.top >= box.top && rect.bottom <= box.bottom,
      };
    });
    return { id, scrollLeft: host.scrollLeft, text };
  }), ids);
}

function deepJson(value) {
  let data = { target: value };
  for (let depth = 0; depth < 200; depth++) data = { n: data };
  return JSON.stringify(data);
}

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + '/compare.html');
  await page.locator('#array-mode').selectOption('key');
  await page.locator('#key-field').fill('id');
  const left = Array.from({ length: 4000 }, (_, id) => ({ id, nested: { changed: 1 } }));
  const right = left.map((row) => ({ id: row.id, nested: { changed: 2 } })).reverse();
  await page.locator('#input-left').fill(JSON.stringify(left));
  await page.locator('#input-right').fill(JSON.stringify(right));
  const started = performance.now();
  await page.locator('#btn-compare').click();
  await page.waitForFunction(() => document.getElementById('diff-info').textContent.startsWith('1 / 4000'));
  let selected = await selectedRows();
  console.log(JSON.stringify({ case: 'reversed-keyed-first', elapsedMs: performance.now() - started, selected }));
  assert.deepEqual(selected.map((row) => row.path), ['/0/nested/changed', '/3999/nested/changed']);
  assert.ok(selected.every((row) => row.visible), 'both paired differences must remain inside their viewports after scroll events');
  assert.ok(selected.every((row) => row.entries < 100));
  assert.ok(selected[0].text.includes('1'));
  assert.ok(selected[1].text.includes('2'));

  await page.locator('#diff-next').click();
  selected = await selectedRows();
  console.log(JSON.stringify({ case: 'reversed-keyed-next', selected }));
  assert.deepEqual(selected.map((row) => row.path), ['/1/nested/changed', '/3998/nested/changed']);
  assert.ok(selected.every((row) => row.visible));

  await page.evaluate(() => { document.getElementById('tree-left').scrollTop = 250; });
  await settle();
  const scroll = await page.evaluate(() => ['left', 'right'].map((side) => document.getElementById('tree-' + side).scrollTop));
  assert.ok(Math.abs(scroll[0] - scroll[1]) < 1, 'manual scrolling must continue to synchronize');

  await page.locator('#diff-prev').click();
  await settle();
  const leftEntry = page.locator('#tree-left .entry[role="treeitem"][data-path="/0/nested"]');
  const leftToggle = leftEntry.locator('.toggle');
  await leftToggle.click();
  await settle();
  assert.equal(await leftEntry.getAttribute('aria-expanded'), 'false');
  const rightEntry = page.locator('#tree-right .entry[role="treeitem"][data-path="/3999/nested"]');
  assert.equal(await rightEntry.getAttribute('aria-expanded'), 'false');
  await leftToggle.click();
  await settle();
  assert.equal(await rightEntry.getAttribute('aria-expanded'), 'true');

  await leftToggle.click();
  await settle();
  assert.equal(await leftEntry.getAttribute('aria-expanded'), 'false');
  await page.locator('#tree-left').focus();
  await page.keyboard.press('Enter');
  await settle();
  const keyboardFocus = await page.evaluate(() => {
    const tree = document.activeElement;
    const entry = document.getElementById(tree.getAttribute('aria-activedescendant'));
    return { path: entry?.dataset.path, host: tree.id, role: entry?.getAttribute('role'), expanded: entry?.getAttribute('aria-expanded') };
  });
  console.log(JSON.stringify({ case: 'toggle-keeps-keyboard-focus', ...keyboardFocus }));
  assert.deepEqual(keyboardFocus, { path: '/0/nested', host: 'tree-left', role: 'treeitem', expanded: 'true' });
  await page.keyboard.press('Space');
  await settle();
  assert.equal(await leftEntry.getAttribute('aria-expanded'), 'false');
  assert.equal(await rightEntry.getAttribute('aria-expanded'), 'false');

  await page.goto(base + '/formatter.html');
  await page.locator('#input').fill(JSON.stringify(Array.from({ length: 25001 }, (_, i) => i)));
  await page.locator('#btn-format').click();
  await page.waitForFunction(() => document.getElementById('busy').hidden);
  await page.locator('#view-tree').click();
  await page.locator('#search').fill('25000');
  await page.waitForFunction(() => document.querySelector('#tree .entry.current')?.dataset.path === '/25000');
  await settle();
  const distant = await page.evaluate(() => {
    const host = document.getElementById('tree');
    const target = host.querySelector('.entry.current');
    const viewport = host.getBoundingClientRect();
    const box = target.getBoundingClientRect();
    return { path: target.dataset.path, visible: box.top >= viewport.top && box.bottom <= viewport.bottom, entries: host.querySelectorAll('.entry').length };
  });
  assert.equal(distant.visible, true);
  assert.ok(distant.entries < 100);
  await page.locator('#btn-clear').click();
  await page.locator('#input').fill(deepJson('needle-deep'));
  await page.locator('#btn-format').click();
  await page.waitForFunction(() => document.getElementById('busy').hidden);
  await page.locator('#search').fill('needle-deep');
  await page.waitForFunction(() => document.querySelector('#tree .entry.current .v')?.textContent === '"needle-deep"');
  const deepSearch = await selectedTextBounds(['tree']);
  console.log(JSON.stringify({ case: 'depth-200-search-text-visible', selected: deepSearch }));
  assert.ok(deepSearch.every((row) => row.text.length === 2 && row.text.every((text) => text.visible)), 'deep search must bring key and value text into the horizontal viewport');

  await page.goto(base + '/compare.html');
  await page.locator('#input-left').fill(deepJson(1));
  await page.locator('#input-right').fill(deepJson(2));
  await page.locator('#btn-compare').click();
  await page.waitForFunction(() => document.getElementById('diff-info').textContent.startsWith('1 / 1'));
  const deepDiff = await selectedTextBounds(['tree-left', 'tree-right']);
  console.log(JSON.stringify({ case: 'depth-200-diff-text-visible', selected: deepDiff }));
  assert.ok(deepDiff.every((row) => row.text.length === 2 && row.text.every((text) => text.visible)), 'deep diff must bring both keys and values into each horizontal viewport');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ case: 'formatter-distant-search', ...distant, browser: browser.version(), errors }));
} finally {
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
}
