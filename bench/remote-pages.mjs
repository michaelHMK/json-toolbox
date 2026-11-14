// Optional correctness check with a deliberately slow Worker response boundary:
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_EXECUTABLE=/path/to/chrome node bench/remote-pages.mjs [repo]
// This checks real layout, asynchronous navigation and scroll synchronization;
// it deliberately does not measure CPU performance.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

const root = resolve(process.argv[2] || '.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = createServer(async (request, response) => {
  try {
    const file = resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
    if (!file.startsWith(root + '/')) throw new Error('Invalid path');
    const data = await readFile(file);
    response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' })[extname(file)] || 'application/octet-stream');
    response.end(data);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.addInitScript(() => {
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    set onmessage(handler) {
      super.onmessage = (event) => setTimeout(() => handler(event), 75);
    }
  };
});

try {
  await page.goto(base + '/formatter.html');
  const source = JSON.stringify({ nested: { value: 'needle' }, rows: Array(4000).fill(1), padding: 'x'.repeat(600000) });
  await page.locator('#file-input').setInputFiles({ name: 'large.json', mimeType: 'application/json', buffer: Buffer.from(source) });
  await page.waitForFunction(() => document.querySelector('#output-text').textContent.includes('nested'));
  assert.equal(await page.locator('#input').inputValue(), '');
  await page.locator('#view-tree').click();
  await page.waitForSelector('#tree .entry[data-path="/nested"]');
  await page.locator('#search').fill('needle');
  await page.waitForFunction(() => document.querySelector('#tree .current')?.dataset.path === '/nested/value');
  await page.locator('#search').fill('');
  await page.waitForFunction(() => document.querySelector('#match-info').textContent === '');
  await page.locator('#tree').focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => {
    const tree = document.querySelector('#tree');
    return document.getElementById(tree.getAttribute('aria-activedescendant'))?.dataset.path === '/nested/value';
  });
  await page.locator('#view-text').click();
  await page.locator('#view-tree').click();
  await page.waitForSelector('#tree .entry[data-path="/nested/value"]');
  console.log(JSON.stringify({ scenario: 'formatter-file-remote-search-keyboard-view', ok: true }));

  await page.goto(base + '/compare.html');
  const users = Array.from({ length: 1500 }, (_, i) => ({ id: i, nested: { v: i } }));
  const left = { users, padding: 'x'.repeat(600000) };
  const right = {
    users: users.toReversed().map((value) => value.id === 100 ? { id: 100, nested: { v: -1 } } : value),
    padding: left.padding,
  };
  await page.locator('#array-mode').selectOption('key');
  await page.locator('#key-field').fill('id');
  await page.locator('#file-input-left').setInputFiles({ name: 'left.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(left)) });
  await page.locator('#file-input-right').setInputFiles({ name: 'right.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(right)) });
  await page.waitForFunction(() => document.querySelector('#tree-left .entry.current')?.dataset.path === '/users/100/nested/v'
    && document.querySelector('#tree-right .entry.current')?.dataset.path === '/users/1399/nested/v');
  // Let delayed responses and resulting scroll events settle before checking
  // that synchronization did not move either side away from its paired row.
  await page.waitForTimeout(350);
  const positions = await page.evaluate(() => ['left', 'right'].map((side) => {
    const tree = document.querySelector('#tree-' + side);
    const current = tree.querySelector('.entry.current');
    const row = current.getBoundingClientRect();
    const viewport = tree.getBoundingClientRect();
    return {
      side, top: tree.scrollTop, path: current.dataset.path,
      pinned: current.classList.contains('virtual-active-outside'),
      visible: row.top >= viewport.top && row.bottom <= viewport.bottom,
    };
  }));
  assert.ok(positions.every((position) => position.visible && !position.pinned), JSON.stringify(positions));
  assert.ok(Math.abs(positions[0].top - positions[1].top) > 10000, JSON.stringify(positions));
  await page.locator('#only-diff').check();
  await page.waitForFunction(() => document.querySelectorAll('#tree-left .entry').length < 20
    && document.querySelectorAll('#tree-right .entry').length < 20);
  await page.locator('#only-diff').uncheck();
  await page.waitForFunction(() => document.querySelector('#tree-right .entry.current')?.dataset.path === '/users/1399/nested/v');
  await page.locator('#view-text').click();
  await page.waitForSelector('#text-view .virtual-text-row');
  await page.locator('#view-struct').click();
  await page.waitForSelector('#tree-left .entry.current');
  console.log(JSON.stringify({ scenario: 'compare-remote-keyed-delayed-worker-scroll-filter-view', ok: true, positions }));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ pageErrors: errors }));
} finally {
  await browser.close();
  server.close();
}
