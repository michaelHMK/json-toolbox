// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node bench/file-import.mjs [repo]
// See README.md for scenarios, repetitions, verification and optional budgets.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { LARGE_INPUT_THRESHOLD } from '../src/shared/text-input.js';

function numberOption(name, fallback, minimum = 0, integer = false) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < minimum || (integer && !Number.isInteger(value))) {
    throw new Error(`Invalid ${name}: ${process.env[name]}`);
  }
  return value;
}

function listOption(name, fallback, allowed) {
  const values = (process.env[name] || fallback).split(',').map((value) => value.trim());
  if (values.some((value) => !allowed.includes(value))) throw new Error(`Invalid ${name}: ${values}`);
  return [...new Set(values)];
}

const root = resolve(process.argv[2] || '.');
const scenarios = listOption('BENCH_SCENARIOS', 'regular,decimals,invalid', ['regular', 'decimals', 'invalid', 'deep']);
const actions = listOption('BENCH_ACTIONS', 'format,minify', ['format', 'minify']);
const repeats = numberOption('BENCH_REPEATS', 3, 1, true);
const sizeMiB = numberOption('BENCH_FILE_MIB', 50, 0.001);
const decimalMiB = numberOption('BENCH_DECIMAL_MIB', 4, 0.001);
const depth = numberOption('BENCH_DEEP_DEPTH', 10000, 1, true);
const maxTotalMs = numberOption('BENCH_MAX_MS', 0);
const maxLongTaskMs = numberOption('BENCH_MAX_LONG_TASK_MS', 0);
const verify = process.env.BENCH_VERIFY !== '0';
const measureMemory = process.env.BENCH_MEMORY === '1';
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
let browser;
const results = [];

async function prepareFile(page, scenario) {
  // A separate browser task keeps fixture construction and File encoding out
  // of both elapsed time and Long Task entries for the actual import.
  await page.evaluate(({ scenario, bytes, depth }) => {
    let source;
    let count = 0;
    if (scenario === 'regular') {
      const chunks = ['{"rows":['];
      let length = chunks[0].length;
      for (let i = 0; length < bytes - 1024; i++) {
        const item = (i ? ',' : '') + JSON.stringify({
          id: i, label: `row ${i}`, payload: 'x'.repeat(96), nested: { value: i, active: true },
        });
        chunks.push(item);
        length += item.length;
      }
      chunks.push(`],"padding":"${'p'.repeat(bytes - length - '],"padding":""}'.length)}"}`);
      source = chunks.join('');
    } else if (scenario === 'decimals') {
      count = Math.floor((bytes - 1) / 5);
      source = '[' + '1.20,'.repeat(count - 1) + '1.20]';
    } else if (scenario === 'invalid') {
      const prefix = '{"payload":"';
      const suffix = '",!}';
      source = prefix + 'x'.repeat(bytes - prefix.length - suffix.length) + suffix;
    } else {
      // Force the large-input path without making nesting itself consume MiB.
      source = ' '.repeat(2 * 1024 * 1024 + 1) + '['.repeat(depth) + '0' + ']'.repeat(depth);
    }
    const transfer = new DataTransfer();
    transfer.items.add(new File([source], `${scenario}.json`, { type: 'application/json' }));
    window.importBench = { source, transfer, scenario, count, depth };
  }, { scenario, bytes: Math.round((scenario === 'decimals' ? decimalMiB : sizeMiB) * 1024 * 1024), depth });
}

async function measureImport(page, action) {
  await page.evaluate((action) => {
    const bench = window.importBench;
    bench.longTasks = [];
    bench.observer = new PerformanceObserver((list) => bench.longTasks.push(...list.getEntries()));
    bench.observer.observe({ type: 'longtask' });
    const terminal = new MutationObserver(() => {
      const status = document.querySelector('#status').textContent;
      const failed = !document.querySelector('#error').hidden;
      if (!failed && !status.trim()) return;
      terminal.disconnect();
      // The status mutation precedes layout/paint. Two frames include the first
      // opportunity to display the completed output (or the error state).
      requestAnimationFrame(() => requestAnimationFrame(() => { bench.completed = performance.now(); }));
    });
    terminal.observe(document.querySelector('#status'), { childList: true, subtree: true, characterData: true });
    terminal.observe(document.querySelector('#error'), { attributes: true, childList: true, subtree: true, characterData: true });
    bench.started = performance.now();
    // Dispatch in the next task so its Long Task start is after the boundary.
    setTimeout(() => document.querySelector('#input-pane').dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: bench.transfer,
    })), 0);
  }, action);
  await page.waitForFunction(() => Number.isFinite(window.importBench.completed), null, { timeout: 120000 });
  return page.evaluate(async (measureMemory) => {
    const bench = window.importBench;
    // Let queued PerformanceObserver notifications arrive before disconnecting;
    // takeRecords also drains entries that have not reached the callback yet.
    await new Promise((done) => setTimeout(done, 50));
    bench.longTasks.push(...bench.observer.takeRecords());
    bench.observer.disconnect();
    const durations = bench.longTasks
      .filter((entry) => entry.startTime >= bench.started && entry.startTime < bench.completed)
      .map((entry) => entry.duration);
    let agentMemoryMiB = null;
    if (measureMemory && performance.measureUserAgentSpecificMemory) {
      try {
        agentMemoryMiB = (await performance.measureUserAgentSpecificMemory()).bytes / 1048576;
      } catch {}
    }
    return {
      inputBytes: bench.source.length,
      totalMs: +(bench.completed - bench.started).toFixed(2),
      maxLongTaskMs: +Math.max(0, ...durations).toFixed(2),
      longTaskCount: durations.length,
      pageHeapMiB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(2) : null,
      agentMemoryMiB: agentMemoryMiB === null ? null : +agentMemoryMiB.toFixed(2),
      error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
      textareaHidden: document.querySelector('#input').hidden,
      previewVisible: !document.querySelector('#input-view').hidden,
    };
  }, measureMemory);
}

async function verifyImport(page, action) {
  // Copying and constructing expected output happen after the measured phase.
  // Return only booleans: do not clone hundreds of MiB into the Node process.
  return page.evaluate((action) => {
    const { source, scenario, count, depth } = window.importBench;
    function copy(selector) {
      const element = document.querySelector(selector);
      if (!element.classList.contains('virtual-text')) return element.value ?? element.textContent;
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
      const clipboardData = new DataTransfer();
      element.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }));
      return clipboardData.getData('text/plain');
    }
    const input = document.querySelector('#input');
    // Inspect the real caret/range before Ctrl+A changes copy-selection state.
    let selectedErrorPosition = null;
    let errorSelectionMatches = null;
    if (scenario === 'invalid') {
      const expected = source.indexOf('!');
      if (input.hidden) {
        const selection = document.getSelection();
        const span = selection?.anchorNode?.parentElement?.closest('[data-text-offset]');
        if (span && document.querySelector('#input-view').contains(span)) {
          selectedErrorPosition = Number(span.dataset.textOffset) + selection.anchorOffset;
        }
        errorSelectionMatches = selectedErrorPosition === expected && selection?.toString() === '!';
      } else {
        selectedErrorPosition = input.selectionStart;
        errorSelectionMatches = selectedErrorPosition === expected && input.selectionEnd === expected + 1;
      }
    }
    const completeInputCopy = copy(input.hidden ? '#input-view' : '#input') === source;
    const error = document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent;
    if (scenario === 'invalid') {
      const position = source.indexOf('!');
      return {
        completeInputCopy,
        exactOutput: null,
        selectedErrorPosition,
        errorSelectionMatches,
        errorLocationMatches: !!error && (error.toLowerCase().includes(`position ${position}`) || error.toLowerCase().includes(`line 1 column ${position + 1}`)),
      };
    }
    if (error) return { completeInputCopy, exactOutput: false, errorLocationMatches: null };
    const output = copy('#output-text');
    let exactOutput;
    if (scenario === 'decimals') {
      const expected = action === 'minify' ? source : '[\n' + '  1.20,\n'.repeat(count - 1) + '  1.20\n]';
      exactOutput = output === expected;
    } else if (scenario === 'deep') {
      if (action === 'minify') exactOutput = output === source.trimStart();
      else {
        // Validate every character without allocating another O(depth²) string
        // or calling JSON.stringify, whose recursion limit is under test.
        let at = 0;
        function line(indent, token, newline = true) {
          const tail = token + (newline ? '\n' : '');
          const matches = /^ *$/.test(output.slice(at, at + indent)) && output.startsWith(tail, at + indent);
          at += indent + tail.length;
          return matches;
        }
        exactOutput = true;
        for (let i = 0; i < depth && exactOutput; i++) exactOutput = line(i * 2, '[');
        if (exactOutput) exactOutput = line(depth * 2, '0');
        for (let i = depth - 1; i >= 0 && exactOutput; i--) exactOutput = line(i * 2, ']', i !== 0);
        exactOutput &&= at === output.length;
      }
    } else {
      const data = JSON.parse(source);
      exactOutput = output === (action === 'format' ? JSON.stringify(data, null, 2) : JSON.stringify(data));
    }
    return { completeInputCopy, exactOutput, errorLocationMatches: null };
  }, action);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return +((sorted[middle] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2).toFixed(2);
}

try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE,
    args: ['--enable-precise-memory-info'],
  });
  const catalog = JSON.parse(await readFile(resolve(root, '_locales/en/messages.json'), 'utf8'));
  for (const scenario of scenarios) {
    for (const action of actions) {
      for (let iteration = 1; iteration <= repeats; iteration++) {
        const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
        try {
          // Exercise localized parse locations under HTTP, just as the
          // extension does. Bare message keys have no line/column substitutions.
          await page.addInitScript((catalog) => {
            globalThis.chrome = { ...globalThis.chrome, i18n: {
              getUILanguage: () => 'en',
              getMessage(key, substitutions = []) {
                if (key === '@@bidi_dir') return 'ltr';
                const entry = catalog[key];
                if (!entry) return '';
                const values = Array.isArray(substitutions) ? substitutions : [substitutions];
                return entry.message.replace(/\$([a-z_]+)\$/gi, (_, name) =>
                  (entry.placeholders?.[name.toLowerCase()]?.content || '')
                    .replace(/\$(\d+)/g, (_, index) => values[Number(index) - 1] || ''));
              },
            } };
          }, catalog);
          const runtimeErrors = [];
          page.on('pageerror', (error) => runtimeErrors.push(error.message));
          await page.goto(base + (action === 'format' ? '/formatter.html' : '/minify.html'));
          await prepareFile(page, scenario);
          const measurement = await measureImport(page, action);
          const checks = await verifyImport(page, action);
          const large = measurement.inputBytes > LARGE_INPUT_THRESHOLD;
          const validationErrors = [...runtimeErrors];
          if (scenario === 'invalid' ? !measurement.error : measurement.error !== null) validationErrors.push('Unexpected success/error state');
          if (measurement.textareaHidden !== large || measurement.previewVisible !== large) validationErrors.push('Unexpected input preview state');
          if (!checks.completeInputCopy) validationErrors.push('Input copy differs from the source');
          if (checks.exactOutput === false) validationErrors.push('Output differs from the expected complete text');
          if (checks.errorLocationMatches === false) validationErrors.push('Parse error does not identify the expected location');
          if (checks.errorSelectionMatches === false) validationErrors.push('Input selection does not identify the expected error character');
          const row = { scenario, action, iteration, ...measurement, ...checks, validationErrors };
          results.push(row);
          console.error(JSON.stringify(row));
        } finally {
          await page.close();
        }
      }
    }
  }
  const summaries = scenarios.flatMap((scenario) => actions.map((action) => {
    const rows = results.filter((row) => row.scenario === scenario && row.action === action);
    const totalMs = median(rows.map((row) => row.totalMs));
    const longTaskMs = median(rows.map((row) => row.maxLongTaskMs));
    const budgetErrors = [];
    if (maxTotalMs && totalMs > maxTotalMs) budgetErrors.push(`Median total ${totalMs} ms > ${maxTotalMs} ms`);
    if (maxLongTaskMs && longTaskMs > maxLongTaskMs) budgetErrors.push(`Median longest task ${longTaskMs} ms > ${maxLongTaskMs} ms`);
    return { scenario, action, repeats, medianTotalMs: totalMs, medianMaxLongTaskMs: longTaskMs, budgetErrors };
  }));
  console.log(JSON.stringify({
    browser: browser.version(), root, verify, measureMemory,
    budgets: { medianTotalMs: maxTotalMs || null, medianMaxLongTaskMs: maxLongTaskMs || null },
    summaries, results,
  }, null, 2));
  if ((verify && results.some((row) => row.validationErrors.length)) || summaries.some((row) => row.budgetErrors.length)) process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
