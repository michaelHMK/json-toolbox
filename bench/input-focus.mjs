// Verify native browser focus and keyboard shortcuts across input-mode changes.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_EXECUTABLE=/path/to/chrome node bench/input-focus.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(process.cwd());
const server = createServer(async (request, response) => {
  try {
    const file = resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
    if (!file.startsWith(root + '/')) throw new Error('Invalid path');
    response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' })[extname(file)] || 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
const results = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.addInitScript(() => {
  window.focusBenchRequests = [];
  window.focusBenchResponses = [];
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', ({ data }) => focusBenchResponses.push({ id: data.id, ok: data.ok }));
    }
    postMessage(message, ...args) {
      focusBenchRequests.push({ id: message.id, action: message.action,
        exactInput: message.text === window.focusBenchExpected?.text && message.text2 === window.focusBenchExpected?.text2 });
      return super.postMessage(message, ...args);
    }
  };
});
const settle = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const activeId = () => page.evaluate(() => document.activeElement?.id);

async function sendTransfer(type, target, text) {
  return page.evaluate(({ type, target, text }) => {
    const element = document.querySelector(target);
    const transfer = new DataTransfer();
    transfer.setData('text/plain', text === 'large' ? focusBenchLarge : text);
    const event = type === 'paste' ? new ClipboardEvent(type, { clipboardData: transfer, bubbles: true, cancelable: true })
      : new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return { prevented: event.defaultPrevented, active: document.activeElement?.id };
  }, { type, target, text });
}

async function checkShortcut(action, count) {
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(({ action, count }) => focusBenchRequests.filter((request) => request.action === action).length >= count, { action, count });
  await page.waitForFunction(({ action, count }) => {
    const request = focusBenchRequests.filter((item) => item.action === action)[count - 1];
    return request && focusBenchResponses.some((response) => response.id === request.id && response.ok);
  }, { action, count });
  await settle();
  const request = await page.evaluate(({ action, count }) => focusBenchRequests.filter((item) => item.action === action)[count - 1], { action, count });
  assert.equal(request.exactInput, true, 'Ctrl+Enter must use the complete input, including the replaced selection');
}

try {
  for (const { name, side, action } of [
    { name: 'formatter', side: '', action: 'format' },
    { name: 'minify', side: '', action: 'minify' },
    { name: 'compare', side: 'left', action: 'diff' },
    { name: 'compare', side: 'right', action: 'diff' },
  ]) {
    for (const type of ['paste', 'drop']) {
      await page.goto(`${base}/${name}.html`);
      if (name === 'formatter') await page.locator('#auto-format').uncheck();
      const suffix = side ? '-' + side : '';
      const input = '#input' + suffix;
      const preview = '#input-view' + suffix;
      if (side) await page.locator('#input-' + (side === 'left' ? 'right' : 'left')).fill('[0]');
      await page.locator(input).fill('[0]');
      await page.evaluate(async ({ input, side }) => {
        const { LARGE_INPUT_THRESHOLD } = await import('/src/shared/text-input.js');
        window.focusBenchLarge = '"' + 'x'.repeat(LARGE_INPUT_THRESHOLD + 1) + '"';
        const expected = '[' + focusBenchLarge + ']';
        window.focusBenchExpected = side === 'left' ? { text: expected, text2: '[0]' }
          : side === 'right' ? { text: '[0]', text2: expected } : { text: expected };
        document.querySelector(input).setSelectionRange(1, 2);
      }, { input, side });
      await page.locator(input).focus();
      const started = performance.now();
      const large = await sendTransfer(type, input, 'large');
      assert.equal(large.prevented, true);
      assert.equal(large.active, preview.slice(1));
      assert.equal(await page.locator(input).inputValue(), '');
      assert.equal(await page.locator(input).isHidden(), true);
      await checkShortcut(action, 1);
      assert.equal(await activeId(), preview.slice(1));

      const smallText = '{"small":true}';
      await page.evaluate(({ side, text }) => {
        focusBenchExpected = side === 'left' ? { text, text2: '[0]' }
          : side === 'right' ? { text: '[0]', text2: text } : { text };
      }, { side, text: smallText });
      const small = await sendTransfer(type, preview, smallText);
      assert.equal(small.prevented, true);
      assert.equal(small.active, input.slice(1));
      assert.equal(await page.locator(input).inputValue(), smallText);
      assert.equal(await page.locator(preview).isHidden(), true);
      const caret = await page.locator(input).evaluate((element) => ({ start: element.selectionStart, end: element.selectionEnd }));
      assert.deepEqual(caret, { start: smallText.length, end: smallText.length });
      await checkShortcut(action, 2);
      assert.equal(await activeId(), input.slice(1));

      // A programmatic update or a drop into an unfocused input must leave the
      // user's focus on the other control, in both directions.
      await page.locator('#btn-clear').focus();
      await page.locator(input).evaluate((element) => element.setSelectionRange(0, element.value.length));
      const unfocusedLarge = await sendTransfer(type, input, 'large');
      const unfocusedSmall = await sendTransfer(type, preview, '[]');
      assert.equal(unfocusedLarge.active, 'btn-clear');
      assert.equal(unfocusedSmall.active, 'btn-clear');
      results.push({ page: name, side: side || null, transfer: type, largeFocus: large.active,
        smallFocus: small.active, shortcuts: 2, insertionSelectionPreserved: true,
        otherControlFocusPreserved: true, elapsedMs: +(performance.now() - started).toFixed(2) });
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: browser.version(), results }, null, 2));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
