// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node bench/worker-transfer.mjs [repo]
// Exercises real browser module Workers under the unified Worker-tree protocol.
import { resolveExtension } from './extension-root.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

const { root, moduleBase } = resolveExtension(process.argv[2]?.startsWith('--') ? '.' : process.argv[2]);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/__worker-transfer.html') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Worker transfer benchmark</title>');
      return;
    }
    const file = resolve(root, '.' + pathname);
    if (!file.startsWith(root + '/')) throw new Error('Invalid path');
    response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html' })[extname(file)] || 'application/octet-stream');
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
const page = await browser.newPage();
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/__worker-transfer.html`);
  const results = await page.evaluate(async (moduleBase) => {
    const rows = [];
    const median = (values) => +values.sort((a, b) => a - b)[Math.floor(values.length / 2)].toFixed(2);
    const settle = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const longTasks = [];
    const observer = new PerformanceObserver((list) => {
      longTasks.push(...list.getEntries().map((entry) => ({ start: entry.startTime, duration: entry.duration })));
    });
    observer.observe({ type: 'longtask' });

    function openWorker() {
      const worker = new Worker(moduleBase + 'worker/index.js', { type: 'module' });
      let sequence = 0;
      let pending;
      worker.onmessage = (event) => pending?.(event.data);
      worker.onerror = (event) => {
        event.preventDefault();
        pending?.({ ok: false, event: 'workererror', error: event.message });
      };
      worker.onmessageerror = () => pending?.({ ok: false, event: 'messageerror', error: 'Response could not be deserialized' });
      return {
        close: () => worker.terminate(),
        async send(request) {
          const started = performance.now();
          const message = await new Promise((done) => {
            const timeout = setTimeout(() => done({ ok: false, event: 'timeout', error: 'Worker response exceeded 15 seconds' }), 15000);
            pending = (result) => { clearTimeout(timeout); pending = undefined; done(result); };
            try { worker.postMessage({ ...request, id: ++sequence }); }
            catch (error) { pending({ ok: false, event: 'posterror', error: error.name + ': ' + error.message }); }
          });
          return { message, elapsedMs: performance.now() - started };
        },
      };
    }

    async function measure(name, request, inspect = () => ({})) {
      const session = openWorker();
      try {
        for (let i = 0; i < 2; i++) {
          const { message } = await session.send(request);
          if (!message.ok) { rows.push({ name, ...message }); return; }
        }
        await settle();
        const started = performance.now();
        const elapsed = [];
        const compute = [];
        let details;
        for (let i = 0; i < 7; i++) {
          const { message, elapsedMs } = await session.send(request);
          if (!message.ok) { rows.push({ name, ...message }); return; }
          elapsed.push(elapsedMs);
          compute.push(message.duration);
          details = inspect(message.result);
        }
        await settle();
        rows.push({
          name, medianRoundTripMs: median(elapsed), medianWorkerComputeMs: median(compute),
          maxMainThreadLongTaskMs: +Math.max(0, ...longTasks.filter((task) => task.start >= started).map((task) => task.duration)).toFixed(2),
          ...details,
        });
      } finally { session.close(); }
    }

    const source = JSON.stringify(Array.from({ length: 50_000 }, (_, i) => ({
      id: i, label: `row ${i}`, payload: 'x'.repeat(128), nested: { value: i, active: true },
    })));
    const inputMiB = +(source.length / 1024 / 1024).toFixed(2);
    rows.push({ name: 'configuration', inputMiB, warmups: 2, samples: 7, note: 'All parsed object graphs remain in the Worker; responses contain only formatted text, diff summaries, or bounded tree windows.' });
    await measure('ordinary-fresh-parse', { action: 'parse', text: source }, (result) => ({ hasData: Object.hasOwn(result, 'data') }));
    await measure('ordinary-cached-parse', { action: 'parse', text: source, retainSnapshot: true }, (result) => ({ hasData: Object.hasOwn(result, 'data'), snapshotId: result.snapshotId }));
    await measure('ordinary-format', {
      action: 'format', text: source, retainSnapshot: true,
    }, (result) => ({ hasData: Object.hasOwn(result, 'data'), outputMiB: +(result.text.length / 1024 / 1024).toFixed(2) }));
    await measure('ordinary-diff', {
      action: 'diff', text: source, text2: source, retainSnapshot: true, includePreviews: false,
    }, (result) => ({ hasData: Object.hasOwn(result, 'leftData'), total: result.total }));

    for (const depth of [1000, 3000, 20_000]) {
      const left = '{"child":'.repeat(depth) + '0' + '}'.repeat(depth);
      const right = '{"child":'.repeat(depth) + '1' + '}'.repeat(depth);
      await measure(`deep-${depth}-parse`, { action: 'parse', text: left, retainSnapshot: true }, (result) => ({ snapshotId: result.snapshotId }));
      await measure(`deep-${depth}-diff-summary`, {
        action: 'diff', text: left, text2: right, retainSnapshot: true, includePreviews: false,
      }, (result) => ({ total: result.total, pathLength: result.diffs[0].leftPath.length }));

      const treeSession = openWorker();
      try {
        const saved = await treeSession.send({ action: 'parse', text: left, retainSnapshot: true });
        if (!saved.message.ok) throw new Error(saved.message.error);
        const windowRes = await treeSession.send({
          action: 'tree', operation: 'update', kind: 'document',
          snapshotId: saved.message.result.snapshotId, options: {}, count: 64,
        });
        if (!windowRes.message.ok) throw new Error(windowRes.message.error);
        rows.push({
          name: `deep-${depth}-tree-window`, ok: windowRes.message.ok,
          rowCount: windowRes.message.result.rowCount, rows: windowRes.message.result.rows.length,
          roundTripMs: +windowRes.elapsedMs.toFixed(2),
        });
      } finally { treeSession.close(); }
    }

    const { createTaskRunner } = await import(moduleBase + 'shared/worker-client.js');
    let clientWorker;
    const runTask = createTaskRunner({
      serialize: true,
      createWorker: () => (clientWorker = new Worker(moduleBase + 'worker/index.js', { type: 'module' })),
    });
    try {
      const text = '{"child":'.repeat(20_000) + '0' + '}'.repeat(20_000);
      const deep = await runTask('parse', { text, retainSnapshot: true });
      const windowRes = await runTask('tree', { operation: 'update', kind: 'document', snapshotId: deep.result.snapshotId, options: {}, count: 64 });
      const next = await runTask('parse', { text: '{"alive":true}', retainSnapshot: true });
      rows.push({
        name: 'client-handles-deep-20k-directly-via-worker-windows',
        deepOk: deep.ok, windowOk: windowRes.ok, windowRows: windowRes.result?.rows?.length,
        nextOk: next.ok,
      });
      if (!deep.ok || !windowRes.ok || !next.ok) {
        throw new Error('Client deep Worker window or later task failed');
      }
    } finally { clientWorker?.terminate(); }
    observer.disconnect();
    return rows;
  }, moduleBase);
  console.log(JSON.stringify({ browser: browser.version(), root, results }, null, 2));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
