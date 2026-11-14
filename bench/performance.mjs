// Local HTTP/browser integration benchmark; extension startup/i18n are excluded.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_EXECUTABLE=/path/to/chrome node bench/performance.mjs
// PERF_TREE_MIB=25 (default), PERF_INPUT_BUDGET_MS=50, PERF_FRAME_BUDGET_MS=35.
// PERF_PROFILE_TEXT_LINES=1 optionally instruments line-index construction.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { createFormatSource } from './format-data.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(process.cwd());
const treeMiB = Number(process.env.PERF_TREE_MIB || 25);
const inputBudget = Number(process.env.PERF_INPUT_BUDGET_MS || 50);
const frameBudget = Number(process.env.PERF_FRAME_BUDGET_MS || 35);
const fixtures = new Map();
const fixture = (kind) => {
  if (!fixtures.has(kind)) fixtures.set(kind, kind === 'tree' ? createFormatSource('tz', treeMiB)
    : kind === 'single' ? '"' + 'x'.repeat(10 * 1024 * 1024 - 2) + '"'
      : '[' + ('{"id":1,"label":"multiline record for local input measurement","amount":19.90},\n').repeat(Math.ceil(10 * 1024 * 1024 / 80)) + 'null]');
  return fixtures.get(kind);
};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/__fixture__') {
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end(fixture(url.searchParams.get('kind')));
      return;
    }
    if (url.pathname === '/__textarea__') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><textarea id="calibrate" wrap="off" spellcheck="false" style="width:600px;height:500px;font:14px/21px monospace"></textarea>');
      return;
    }
    const file = resolve(root, '.' + url.pathname);
    if (!file.startsWith(root + '/')) throw new Error('Invalid path');
    response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' })[extname(file)] || 'application/octet-stream');
    let contents = await readFile(file);
    if (process.env.PERF_PROFILE_TEXT_LINES && url.pathname === '/src/core/text-lines.js') {
      contents = contents.toString().replace('export function createTextLineIndex(', 'function measuredCreateTextLineIndex(') + `
export function createTextLineIndex(...args) {
  const start = performance.now();
  const result = measuredCreateTextLineIndex(...args);
  (globalThis.benchLineTimings ??= []).push({ start, duration: performance.now() - start, lines: result.count, chars: args[0].length });
  return result;
}`;
    }
    response.end(contents);
  } catch { response.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(60000);
const errors = [];
const results = [];
const violations = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.addInitScript(() => {
  window.benchLongTasks = [];
  window.benchMessages = [];
  window.benchSendTimings = [];
  window.benchDecodeTimings = [];
  const nativeDecode = TextDecoder.prototype.decode;
  TextDecoder.prototype.decode = function(...args) {
    const start = performance.now();
    const result = nativeDecode.apply(this, args);
    benchDecodeTimings.push({ start, duration: performance.now() - start, chars: result.length });
    return result;
  };
  window.benchMark = performance.now();
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) benchLongTasks.push({ start: entry.startTime, duration: entry.duration });
  }).observe({ type: 'longtask', buffered: true });
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      this.requests = new Map();
      this.addEventListener('message', ({ data }) => {
        const request = this.requests.get(data.id);
        this.requests.delete(data.id);
        const result = data.result || {};
        benchMessages.push({ action: request?.action, operation: request?.operation, ok: data.ok,
          includeData: request?.includeData, duration: data.duration,
          elapsedMs: request ? performance.now() - request.started : null,
          keys: Object.keys(result), rowCount: result.rowCount, rows: result.rows?.length,
          nestedRowValue: result.rows?.some((row) => row?.value && typeof row.value === 'object' && Object.keys(row.value).length > 0) || false,
        });
      });
    }
    postMessage(message, ...args) {
      this.requests.set(message.id, { action: message.action, operation: message.operation,
        includeData: message.includeData, started: performance.now() });
      const start = performance.now();
      const result = super.postMessage(message, ...args);
      benchSendTimings.push({ start, duration: performance.now() - start, action: message.action,
        textChars: message.text?.length || 0, secondTextChars: message.text2?.length || 0 });
      return result;
    }
  };
});
const settle = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const mark = () => page.evaluate(() => { benchMark = performance.now(); benchMessages.length = 0; });
const collect = async (scenario, extra = {}) => {
  await settle();
  const measurement = await page.evaluate(() => {
    const tasks = benchLongTasks.filter((task) => task.start >= benchMark);
    return { elapsedMs: +(performance.now() - benchMark).toFixed(2),
      longTasks: tasks.map((task) => +task.duration.toFixed(2)),
      longestTaskMs: +Math.max(0, ...tasks.map((task) => task.duration)).toFixed(2),
      sendTasks: benchSendTimings.filter((entry) => entry.start >= benchMark),
      decodeTasks: benchDecodeTimings.filter((entry) => entry.start >= benchMark),
      lineIndexTasks: (window.benchLineTimings || []).filter((entry) => entry.start >= benchMark),
      messages: benchMessages.slice() };
  });
  const result = { scenario, ...extra, ...measurement };
  results.push(result);
  return result;
};
const noTreeClone = (measurement) => {
  assert.ok(measurement.messages.every((message) => !message.keys.some((key) => ['data', 'leftData', 'rightData', 'serializedData'].includes(key))), 'large documents must not transfer complete object graphs');
  const windows = measurement.messages.filter((message) => message.action === 'tree');
  assert.ok(windows.length > 0, 'large trees must request a Worker row window');
  assert.ok(windows.every((message) => message.rows <= 256 && !message.nestedRowValue), 'Worker responses must contain bounded, shallow row descriptors');
};
const prepareTransfer = (kind) => page.evaluate(async (kind) => {
  window.benchSource = await (await fetch('/__fixture__?kind=' + kind)).text();
  window.benchTransfer = new DataTransfer();
  benchTransfer.setData('text/plain', benchSource);
}, kind);

try {
  // Measure the textarea's real write + forced layout cost around the threshold.
  for (const shape of ['single', 'multiline']) {
    for (const kib of [256, 512, 1024]) {
      await page.goto(base + '/__textarea__');
      await page.evaluate(({ shape, kib }) => {
        const row = shape === 'single' ? 'x' : 'record value 123456789\n';
        window.calibrationSource = row.repeat(Math.ceil(kib * 1024 / row.length)).slice(0, kib * 1024);
      }, { shape, kib });
      await settle();
      const samples = [];
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => { document.querySelector('#calibrate').value = ''; });
        await settle();
        samples.push(await page.evaluate(() => {
          const textarea = document.querySelector('#calibrate');
          const start = performance.now();
          textarea.value = calibrationSource;
          void textarea.scrollHeight;
          return performance.now() - start;
        }));
      }
      samples.sort((a, b) => a - b);
      results.push({ scenario: 'textarea-threshold', shape, kib, medianWriteLayoutMs: +samples[1].toFixed(2), maxWriteLayoutMs: +samples[2].toFixed(2) });
    }
  }

  // Synthetic transfer dispatch invokes the production paste/drop handlers.
  // Clipboard acquisition/source generation happen outside the measured task.
  for (const name of ['formatter', 'compare', 'minify']) {
    for (const shape of ['single', 'multiline']) {
      for (const type of ['paste', 'drop']) {
        await page.goto(`${base}/${name}.html`);
        if (name === 'formatter') await page.locator('#auto-format').uncheck();
        await prepareTransfer(shape);
        await settle();
        await mark();
        const input = await page.evaluate(({ name, type }) => {
          const suffix = name === 'compare' ? '-left' : '';
          const textarea = document.querySelector('#input' + suffix);
          const event = type === 'paste' ? new ClipboardEvent(type, { clipboardData: benchTransfer, bubbles: true, cancelable: true })
            : new DragEvent(type, { dataTransfer: benchTransfer, bubbles: true, cancelable: true });
          const start = performance.now();
          textarea.dispatchEvent(event);
          const preview = document.querySelector('#input-view' + suffix);
          void preview.scrollHeight;
          return { inputMiB: benchSource.length / 1024 / 1024, dispatchLayoutMs: +(performance.now() - start).toFixed(2),
            prevented: event.defaultPrevented, textareaLength: textarea.value.length,
            textareaHidden: textarea.hidden, previewHidden: preview.hidden,
            renderedRows: preview.querySelectorAll('.virtual-text-row').length };
        }, { name, type });
        const measurement = await collect(`${name}-${type}-10MiB-${shape}`, input);
        assert.ok(input.prevented && input.textareaHidden && !input.previewHidden);
        assert.equal(input.textareaLength, 0);
        assert.ok(input.renderedRows < 150);
        if (input.dispatchLayoutMs >= inputBudget || measurement.longestTaskMs >= inputBudget) violations.push(`${measurement.scenario}: input task exceeded ${inputBudget}ms`);
      }
    }
  }

  await page.goto(base + '/formatter.html');
  await page.locator('#auto-format').uncheck();
  await prepareTransfer('tree');
  await page.evaluate(() => document.querySelector('#input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: benchTransfer, bubbles: true, cancelable: true })));
  await settle();
  await mark();
  await page.locator('#btn-format').click();
  await page.waitForFunction(() => benchMessages.some((message) => message.action === 'format') && document.querySelector('#output-text').textContent.length > 0);
  const formatted = await collect('format-large-text', { inputMiB: treeMiB });
  assert.ok(formatted.messages.every((message) => !message.keys.includes('data')));
  if (formatted.longestTaskMs >= inputBudget) violations.push(`large formatted text main thread task exceeded ${inputBudget}ms`);

  await mark();
  await page.locator('#view-tree').click();
  await page.waitForFunction(() => benchMessages.some((message) => message.action === 'tree') && document.querySelector('#tree .entry[data-path="/0"]'));
  noTreeClone(await collect('format-large-tree-window'));

  await mark();
  await page.locator('#level-select').selectOption('all');
  await page.waitForFunction(() => benchMessages.some((message) => message.action === 'tree' && message.operation === 'update') && !document.querySelector('#tree .virtual-placeholder'));
  const expanded = await collect('tree-expand-all');
  noTreeClone(expanded);
  assert.ok(expanded.messages.some((message) => message.rowCount > 100000));

  for (const open of [false, true]) {
    await mark();
    const syncMs = await page.evaluate(() => {
      const start = performance.now();
      document.querySelector('#tree .entry[data-path="/0"] .toggle').click();
      return performance.now() - start;
    });
    await page.waitForFunction((open) => benchMessages.some((message) => message.operation === 'setOpen')
      && document.querySelector('#tree .entry[data-path="/0"]')?.getAttribute('aria-expanded') === String(open), open);
    const toggle = await collect(`fully-expanded-${open ? 'open' : 'close'}-one`, { syncMs: +syncMs.toFixed(2) });
    noTreeClone(toggle);
    if (toggle.longestTaskMs >= inputBudget) violations.push(`${toggle.scenario}: main thread task exceeded ${inputBudget}ms`);
  }

  await mark();
  const scroll = await page.evaluate(async () => {
    const host = document.querySelector('#tree');
    const frames = [];
    let previous;
    let emptyFrames = 0;
    for (let i = 0; i < 60; i++) {
      const timestamp = await new Promise(requestAnimationFrame);
      if (previous !== undefined) frames.push(timestamp - previous);
      previous = timestamp;
      if (!host.querySelector('.entry[data-path]:not(.virtual-active-outside)')) emptyFrames++;
      host.scrollTop += 600;
    }
    frames.sort((a, b) => a - b);
    return { p50Ms: +frames[Math.floor(frames.length * 0.5)].toFixed(2), p95Ms: +frames[Math.floor(frames.length * 0.95)].toFixed(2),
      maxMs: +frames.at(-1).toFixed(2), emptyFrames, renderedRows: host.querySelectorAll('.entry').length };
  });
  const scrolled = await collect('remote-tree-scroll-60-frames', scroll);
  assert.ok(scroll.renderedRows < 150);
  if (scroll.p95Ms > frameBudget) violations.push(`remote scrolling p95 exceeded ${frameBudget}ms`);
  if (scrolled.longestTaskMs >= inputBudget) violations.push(`remote scrolling main thread task exceeded ${inputBudget}ms`);

  // Both compare inputs support file import and retain only Worker-side trees.
  await page.goto(base + '/compare.html');
  // Playwright setInputFiles({buffer}) itself base64-decodes the full buffer on
  // the UI thread. Prepare native File objects before timing, then invoke the
  // same production import handler through file-drop events.
  await page.evaluate(async () => {
    const text = await (await fetch('/__fixture__?kind=tree')).text();
    window.benchFiles = {};
    for (const side of ['left', 'right']) {
      const transfer = new DataTransfer();
      transfer.items.add(new File([text], `${side}.json`, { type: 'application/json' }));
      benchFiles[side] = transfer;
    }
  });
  await settle();
  await mark();
  for (const side of ['left', 'right']) {
    await page.evaluate((side) => document.querySelector('#input-pane-' + side).dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: benchFiles[side],
    })), side);
    await page.waitForFunction((side) => document.querySelector('#input-' + side).hidden, side);
    assert.equal(await page.locator('#input-' + side).inputValue(), '');
    assert.match(await page.locator('#file-name-' + side).textContent(), new RegExp(side + '\\.json'));
  }
  await page.waitForFunction(() => document.querySelector('#tree-left .entry[data-path="/0"]') && document.querySelector('#tree-right .entry[data-path="/0"]'));
  const imported = await collect('compare-large-file-import-and-tree-windows', { inputMiBPerSide: treeMiB });
  noTreeClone(imported);
  if (imported.longestTaskMs >= inputBudget) violations.push(`large comparison file import main thread task exceeded ${inputBudget}ms`);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: browser.version(), inputBudgetMs: inputBudget, frameBudgetMs: frameBudget, results, violations }, null, 2));
  assert.deepEqual(violations, [], 'configured interactive performance budgets must hold');
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
