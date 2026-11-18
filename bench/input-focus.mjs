// Verify native browser focus and keyboard shortcuts across input-mode changes.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_EXECUTABLE=/path/to/chrome node bench/input-focus.mjs
import { resolveExtension } from './extension-root.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { root, moduleBase } = resolveExtension();
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

async function sendTransfer(type, target, text) {
  return page.evaluate(({ type, target, text }) => {
    const element = document.querySelector(target);
    const transfer = new DataTransfer();
    transfer.setData('text/plain', text === 'large' ? focusBenchLarge : text);
    const event = type === 'paste' ? new ClipboardEvent(type, { clipboardData: transfer, bubbles: true, cancelable: true })
      : new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
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
    { name: 'escape', side: '', action: 'escape' },
    { name: 'unescape', side: '', action: 'unescape' },
    { name: 'compare', side: 'left', action: 'diff' },
    { name: 'compare', side: 'right', action: 'diff' },
  ]) {
    for (const type of ['paste', 'drop']) {
      await page.goto(`${base}/${name}.html`);
      if (name === 'formatter') await page.locator('#auto-format').uncheck();
      const suffix = side ? '-' + side : '';
      const input = '#input' + suffix;
      const editor = page.locator('#input-editor' + suffix + ' .cm-content');
      const hasEditorFocus = () => editor.evaluate((element) => element === document.activeElement);
      if (side) await page.locator('#input-' + (side === 'left' ? 'right' : 'left')).fill('[0]');
      await page.locator(input).fill('[0]');
      await page.evaluate(async ({ input, side, action, moduleBase }) => {
        const { LARGE_INPUT_THRESHOLD } = await import(moduleBase + 'shared/text-input.js');
        const quote = action === 'unescape' ? '\\"' : '"';
        window.focusBenchLarge = quote + 'x'.repeat(LARGE_INPUT_THRESHOLD + 1) + quote;
        const expected = '[' + focusBenchLarge + ']';
        window.focusBenchExpected = side === 'left' ? { text: expected, text2: '[0]' }
          : side === 'right' ? { text: '[0]', text2: expected } : { text: expected };
        document.querySelector(input).setSelectionRange(1, 2);
      }, { input, side, action, moduleBase });
      await page.locator(input).focus();
      const started = performance.now();
      assert.ok(await sendTransfer(type, input, 'large'));
      assert.ok(await hasEditorFocus());
      assert.equal(await page.locator(input).inputValue(), '');
      assert.equal(await page.locator(input).isHidden(), true);
      await checkShortcut(action, 1);
      assert.ok(await hasEditorFocus());

      const smallText = action === 'unescape' ? '{\\"small\\":true}' : '{"small":true}';
      await page.evaluate(({ side, text }) => {
        focusBenchExpected = side === 'left' ? { text, text2: '[0]' }
          : side === 'right' ? { text: '[0]', text2: text } : { text };
      }, { side, text: smallText });
      await editor.press('ControlOrMeta+A');
      await sendTransfer('paste', '#input-editor' + suffix + ' .cm-content', smallText);
      assert.ok(await hasEditorFocus());
      assert.equal(await editor.innerText(), smallText);
      await checkShortcut(action, 2);
      assert.ok(await hasEditorFocus());

      // An incoming transfer on an unfocused textarea must not take focus
      // from the active control when replacing the textarea with the editor.
      await page.locator('#btn-clear').click();
      await page.locator('#btn-clear').focus();
      assert.ok(await sendTransfer(type, input, 'large'));
      assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-clear');
      results.push({ page: name, side: side || null, transfer: type, editorFocusAfterReplacement: true,
        shortcuts: 2, insertionSelectionPreserved: true,
        otherControlFocusPreserved: true, elapsedMs: +(performance.now() - started).toFixed(2) });
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: browser.version(), results }, null, 2));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
