// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_EXECUTABLE=/path/to/chromium node bench/file-import.mjs
// BENCH_FILE_MIB=50 changes fixture size; BENCH_MAX_MS=1500 enables a timing budget.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

const root = resolve(process.argv[2] || '.');
const sizeMiB = Number(process.env.BENCH_FILE_MIB || 50);
const maxTotalMs = Number(process.env.BENCH_MAX_MS || 0);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  try {
    const file = resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
    if (!file.startsWith(root + '/')) throw new Error('Invalid path');
    response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' })[extname(file)] || 'application/octet-stream');
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE,
  args: ['--enable-precise-memory-info'],
});
const results = [];

try {
  for (const action of ['format', 'minify']) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.goto(base + (action === 'format' ? '/formatter.html' : '/minify.html'));
    await page.evaluate(({ bytes, action }) => {
      const chunks = ['{"rows":['];
      let length = chunks[0].length;
      for (let i = 0; length < bytes - 1024; i++) {
        const item = (i ? ',' : '') + JSON.stringify({
          id: i, label: `row ${i}`, payload: 'x'.repeat(96), nested: { value: i, active: true },
        });
        chunks.push(item);
        length += item.length;
      }
      const remaining = bytes - length - '],"padding":""}'.length;
      chunks.push(`],"padding":"${'p'.repeat(remaining)}"}`);
      window.source = chunks.join('');
      if (source.length !== bytes) throw new Error(`Invalid fixture length: ${source.length}`);
      window.longTasks = [];
      window.observer = new PerformanceObserver((list) => {
        longTasks.push(...list.getEntries().map((entry) => entry.duration));
      });
      observer.observe({ type: 'longtask' });
      window.started = performance.now();
      new MutationObserver(() => {
        if (document.querySelector('#status').textContent) window.completed = performance.now();
      }).observe(document.querySelector('#status'), { childList: true, subtree: true, characterData: true });
      const transfer = new DataTransfer();
      transfer.items.add(new File([source], 'complex.json', { type: 'application/json' }));
      document.querySelector('#input-pane').dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: transfer,
      }));
    }, { bytes: Math.round(sizeMiB * 1024 * 1024), action });
    await page.waitForFunction((action) => {
      const status = document.querySelector('#status').textContent;
      return status === (action === 'format' ? 'statusFormatted' : 'statusMinified') || !document.querySelector('#error').hidden;
    }, action, { timeout: 120000 });
    const measurement = await page.evaluate(async () => {
      observer.disconnect();
      let agentMemoryMiB = null;
      if (performance.measureUserAgentSpecificMemory) {
        try {
          agentMemoryMiB = (await performance.measureUserAgentSpecificMemory()).bytes / 1048576;
        } catch {}
      }
      return {
        totalMs: +(completed - started).toFixed(2),
        maxLongTaskMs: +Math.max(0, ...longTasks).toFixed(2),
        pageHeapMiB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(2),
        agentMemoryMiB: agentMemoryMiB === null ? null : +agentMemoryMiB.toFixed(2),
        error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
        textareaHidden: document.querySelector('#input').hidden,
        previewVisible: !document.querySelector('#input-view').hidden,
      };
    });
    assert.equal(measurement.error, null);
    assert.equal(measurement.textareaHidden, sizeMiB > 2);
    assert.equal(measurement.previewVisible, sizeMiB > 2);
    if (maxTotalMs > 0) assert.ok(measurement.totalMs <= maxTotalMs, `${action}: ${measurement.totalMs} ms > ${maxTotalMs} ms`);
    const copied = await page.evaluate((large) => {
      function copy(selector) {
        const element = document.querySelector(selector);
        if (!element.classList.contains('virtual-text')) return element.value ?? element.textContent;
        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
        const clipboardData = new DataTransfer();
        element.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }));
        return clipboardData.getData('text/plain');
      }
      return { input: copy(large ? '#input-view' : '#input'), output: copy('#output-text') };
    }, sizeMiB > 2);
    assert.equal(copied.input, await page.evaluate(() => source));
    const expected = await page.evaluate((action) => {
      const data = JSON.parse(source);
      return action === 'format' ? JSON.stringify(data, null, 2) : JSON.stringify(data);
    }, action);
    assert.equal(copied.output, expected);
    results.push({ action, inputMiB: sizeMiB, ...measurement, completeInputCopy: true, exactOutput: true });
    console.error(JSON.stringify(results.at(-1)));
    await page.close();
  }
  console.log(JSON.stringify({ browser: browser.version(), inputMiB: sizeMiB, maxTotalMs: maxTotalMs || null, results }, null, 2));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
