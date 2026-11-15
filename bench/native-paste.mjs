// Real Chromium clipboard paste: includes native insertion/layout when the page
// does not intercept large input. Use BENCH_VERIFY=0 with an older checkout.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_EXECUTABLE=/path/to/chrome node bench/native-paste.mjs [repo]
// BENCH_PASTE_MIB=20, BENCH_SCREENSHOT_DIR=/path/to/output (optional).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { resolveExtension } from './extension-root.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { root } = resolveExtension(process.argv[2]);
const sizeMiB = Number(process.env.BENCH_PASTE_MIB || 20);
assert.ok(Number.isFinite(sizeMiB) && sizeMiB > 0.25, 'BENCH_PASTE_MIB must exceed the large-input threshold');
const verify = process.env.BENCH_VERIFY !== '0';
const screenshotDir = process.env.BENCH_SCREENSHOT_DIR;
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
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
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
const errors = [];
const results = [];
page.on('pageerror', (error) => errors.push(error.message));

try {
  for (const action of ['escape', 'unescape']) {
    await page.goto(`${base}/${action}.html`);
    // Construct the document and populate the browser's clipboard before timing.
    await page.evaluate(async ({ sizeMiB, action }) => {
      const json = '{"first":"large-paste-source","value":"' + 'x'.repeat(Math.round(sizeMiB * 1024 * 1024)) + '","last":"end-of-source"}';
      const source = action === 'unescape' ? JSON.stringify(json).slice(1, -1) : json;
      await navigator.clipboard.writeText(source);
      const bench = window.pasteBench = { source, tasks: [] };
      bench.observer = new PerformanceObserver((list) => bench.tasks.push(...list.getEntries()));
      bench.observer.observe({ type: 'longtask' });
      bench.done = new Promise((done) => {
        document.addEventListener('paste', (event) => {
          bench.started = performance.now();
          requestAnimationFrame(() => requestAnimationFrame(() => {
            bench.completed = performance.now();
            const input = document.querySelector('#input');
            const preview = document.querySelector('#input-view');
            done({
              sourceChars: source.length, elapsedMs: +(bench.completed - bench.started).toFixed(2),
              prevented: event.defaultPrevented, textareaChars: input.value.length,
              textareaHidden: input.hidden, previewVisible: !!preview && !preview.hidden,
              renderedChars: preview?.textContent.length || 0,
              visibleSource: preview?.textContent.includes('large-paste-source') || false,
            });
          }));
        }, { once: true, capture: true });
      });
    }, { sizeMiB, action });
    await page.locator('#input').focus();
    await page.keyboard.press('ControlOrMeta+V');
    const measurement = await page.evaluate(() => pasteBench.done);
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `${action}.png`) });
    const verification = await page.evaluate(() => {
      const bench = pasteBench;
      bench.tasks.push(...bench.observer.takeRecords());
      bench.observer.disconnect();
      const durations = bench.tasks.filter((task) => task.startTime + task.duration >= bench.started && task.startTime < bench.completed).map((task) => task.duration);
      const input = document.querySelector('#input');
      let copied = input.value;
      if (input.hidden) {
        const preview = document.querySelector('#input-view');
        preview.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
        const clipboardData = new DataTransfer();
        preview.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }));
        copied = clipboardData.getData('text/plain');
      }
      return { maxLongTaskMs: Math.max(0, ...durations), completeInputCopy: copied === bench.source };
    });
    // Native paste must also work on the focused, read-only preview. This is a
    // separate correctness check, outside the large-paste measurement.
    let smallPasteReplacedDocument = false;
    if (measurement.previewVisible) {
      const replacement = 'replacement text';
      await page.evaluate((text) => navigator.clipboard.writeText(text), replacement);
      await page.keyboard.press('ControlOrMeta+V');
      smallPasteReplacedDocument = await page.locator('#input').inputValue() === replacement
        && await page.locator('#input-view').isHidden()
        && await page.locator('#input').evaluate((element) => element === document.activeElement);
    }
    results.push({ action, ...measurement, ...verification, smallPasteReplacedDocument });
    if (verify) {
      assert.ok(measurement.prevented && measurement.textareaHidden && measurement.previewVisible);
      assert.equal(measurement.textareaChars, 0);
      assert.ok(measurement.visibleSource && measurement.renderedChars < 1000);
      assert.equal(verification.completeInputCopy, true);
      assert.equal(smallPasteReplacedDocument, true);
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: browser.version(), root, sizeMiB, verify, results }, null, 2));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
