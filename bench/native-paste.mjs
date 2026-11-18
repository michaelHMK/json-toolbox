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
    await page.evaluate(async ({ sizeMiB, action, verify }) => {
      const json = '{"first":"large-paste-source","value":"' + 'x'.repeat(Math.round(sizeMiB * 1024 * 1024)) + '","last":"end-of-source"}';
      const source = action === 'unescape' ? JSON.stringify(json).slice(1, -1) : json;
      await navigator.clipboard.writeText(source);
      const bench = window.pasteBench = { source, tasks: [] };
      bench.observer = new PerformanceObserver((list) => bench.tasks.push(...list.getEntries()));
      bench.observer.observe({ type: 'longtask' });
      document.addEventListener('paste', (event) => {
        bench.started = performance.now();
        function ready() {
          const editor = document.querySelector('.large-input-editor .cm-content');
          if (verify && !editor?.textContent) {
            requestAnimationFrame(ready);
            return;
          }
          requestAnimationFrame(() => {
            bench.completed = performance.now();
            const input = document.querySelector('#input');
            const visibleText = editor?.textContent ?? (input.hidden ? document.activeElement.textContent : input.value);
            bench.measurement = {
              sourceChars: source.length, elapsedMs: +(bench.completed - bench.started).toFixed(2),
              prevented: event.defaultPrevented, textareaChars: input.value.length,
              textareaHidden: input.hidden, editorFocused: !!editor && editor === document.activeElement,
              renderedChars: visibleText.length, visibleSource: visibleText.includes('end-of-source') || visibleText.includes('large-paste-source'),
            };
          });
        }
        requestAnimationFrame(ready);
      }, { once: true, capture: true });
    }, { sizeMiB, action, verify });
    await page.locator('#input').focus();
    await page.keyboard.press('ControlOrMeta+V');
    await page.waitForFunction(() => pasteBench.measurement);
    const measurement = await page.evaluate(() => pasteBench.measurement);
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `${action}.png`) });
    // Clear the clipboard before copying; leaving the pasted source there
    // would also pass this check if the editor copied nothing.
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('ControlOrMeta+C');
    const verification = await page.evaluate(async () => {
      const bench = pasteBench;
      bench.tasks.push(...bench.observer.takeRecords());
      bench.observer.disconnect();
      const durations = bench.tasks.filter((task) => task.startTime + task.duration >= bench.started && task.startTime < bench.completed).map((task) => task.duration);
      return { maxLongTaskMs: Math.max(0, ...durations), completeInputCopy: await navigator.clipboard.readText() === bench.source };
    });
    // The full-document selection survives copying. Pasting should replace
    // that selection and preserve focus in the editable document.
    let smallPasteReplacedDocument = false;
    if (measurement.editorFocused) {
      const replacement = 'replacement text';
      await page.evaluate((text) => navigator.clipboard.writeText(text), replacement);
      await page.keyboard.press('ControlOrMeta+V');
      smallPasteReplacedDocument = await page.locator('.large-input-editor .cm-content').evaluate((element, value) =>
        element === document.activeElement && element.textContent === value, replacement);
    }
    results.push({ action, ...measurement, ...verification, smallPasteReplacedDocument });
    if (verify) {
      assert.ok(measurement.prevented && measurement.textareaHidden && measurement.editorFocused);
      assert.equal(measurement.textareaChars, 0);
      assert.ok(measurement.visibleSource && measurement.renderedChars < measurement.sourceChars / 2);
      assert.equal(verification.completeInputCopy, true);
      assert.equal(smallPasteReplacedDocument, true);
    }
  }
  if (verify) {
    // Pasting over the textarea selection must preserve both its suffix and
    // one-step undo after moving the document into the large editor.
    await page.goto(`${base}/escape.html`);
    const input = page.locator('#input');
    await input.fill('[0]');
    await input.evaluate(async (element) => {
      element.setSelectionRange(1, 2);
      const row = '  "' + 'x'.repeat(60) + '",\n';
      window.editablePaste = '[\n' + row.repeat(4096) + '  "end"\n]';
      await navigator.clipboard.writeText(editablePaste);
    });
    await page.keyboard.press('ControlOrMeta+V');
    const editor = page.locator('.large-input-editor .cm-content');
    await editor.waitFor();
    assert.ok(await editor.evaluate((element) => element === document.activeElement && element.isContentEditable));
    assert.equal(await input.inputValue(), '');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('ControlOrMeta+C');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), ']', 'paste leaves the caret before the suffix');
    await page.keyboard.press('ControlOrMeta+Z');
    assert.equal(await editor.innerText(), '[0]');
    await page.keyboard.press('ControlOrMeta+Shift+Z');
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('ArrowLeft');
    await page.evaluate(() => navigator.clipboard.writeText('!'));
    await page.keyboard.press('ControlOrMeta+V');
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('ControlOrMeta+C');
    assert.ok(await page.evaluate(async () => await navigator.clipboard.readText() === '[' + editablePaste + '!]'));
    await page.evaluate(() => navigator.clipboard.writeText('replacement'));
    await page.keyboard.press('ControlOrMeta+V');
    assert.equal(await editor.innerText(), 'replacement');
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: browser.version(), root, sizeMiB, verify, results }, null, 2));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
