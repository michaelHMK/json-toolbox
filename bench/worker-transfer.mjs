// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node bench/worker-transfer.mjs [repo]
// Exercises real browser module Workers. Deep objects never cross Playwright's own transport.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

const root = resolve(process.argv[2] || '.');
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
  const results = await page.evaluate(async () => {
    const { createTaskResponseDecoder } = await import('/src/shared/worker-protocol.js');
    const rows = [];
    const median = (values) => +values.sort((a, b) => a - b)[Math.floor(values.length / 2)].toFixed(2);
    const settle = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const longTasks = [];
    const observer = new PerformanceObserver((list) => {
      longTasks.push(...list.getEntries().map((entry) => ({ start: entry.startTime, duration: entry.duration })));
    });
    observer.observe({ type: 'longtask' });

    function openWorker() {
      const decodeTaskResponse = createTaskResponseDecoder();
      const worker = new Worker('/src/worker/index.js', { type: 'module' });
      let sequence = 0;
      let pending;
      worker.onmessage = (event) => {
        const response = decodeTaskResponse(event.data);
        if (!response) return;
        Object.defineProperty(response, 'transportFallback', { value: !!event.data.result?.streamedData });
        pending?.(response);
      };
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
        let fallbackResponses = 0;
        for (let i = 0; i < 7; i++) {
          const { message, elapsedMs } = await session.send(request);
          if (!message.ok) { rows.push({ name, ...message }); return; }
          elapsed.push(elapsedMs);
          compute.push(message.duration);
          if (message.transportFallback) fallbackResponses++;
          details = inspect(message.result);
        }
        await settle();
        rows.push({
          name, medianRoundTripMs: median(elapsed), medianWorkerComputeMs: median(compute), fallbackResponses,
          maxMainThreadLongTaskMs: +Math.max(0, ...longTasks.filter((task) => task.start >= started).map((task) => task.duration)).toFixed(2),
          ...details,
        });
      } finally { session.close(); }
    }

    const source = JSON.stringify(Array.from({ length: 50_000 }, (_, i) => ({
      id: i, label: `row ${i}`, payload: 'x'.repeat(128), nested: { value: i, active: true },
    })));
    const inputMiB = +(source.length / 1024 / 1024).toFixed(2);
    rows.push({ name: 'configuration', inputMiB, warmups: 2, samples: 7, note: 'Round trip includes request transfer, computation, and response transfer. Retained snapshots reuse parsing after warm-up; fresh-parse deliberately disables retention. Medians are not additive.' });
    await measure('ordinary-fresh-parse-with-data', { action: 'parse', text: source }, (result) => ({ count: result.data.length }));
    await measure('ordinary-cached-parse-with-data', { action: 'parse', text: source, retainSnapshot: true }, (result) => ({ count: result.data.length }));
    for (const includeData of [true, false]) {
      await measure(`ordinary-format-data-${includeData}`, {
        action: 'format', text: source, includeData, retainSnapshot: true,
      }, (result) => ({ hasData: Object.hasOwn(result, 'data'), outputMiB: +(result.text.length / 1024 / 1024).toFixed(2) }));
      await measure(`ordinary-diff-data-${includeData}`, {
        action: 'diff', text: source, text2: source, includeData, retainSnapshot: true,
      }, (result) => ({ hasData: Object.hasOwn(result, 'leftData'), total: result.total }));
    }

    function nesting(value) {
      let depth = 0;
      while (value && typeof value === 'object' && Object.hasOwn(value, 'child')) {
        depth++;
        value = value.child;
      }
      return { depth, leaf: value };
    }
    for (const depth of [1000, 3000, 20_000]) {
      const left = '{"child":'.repeat(depth) + '0' + '}'.repeat(depth);
      const right = '{"child":'.repeat(depth) + '1' + '}'.repeat(depth);
      await measure(`deep-${depth}-parse-data`, { action: 'parse', text: left, retainSnapshot: true }, (result) => nesting(result.data));
      await measure(`deep-${depth}-diff-data`, {
        action: 'diff', text: left, text2: right, retainSnapshot: true,
      }, (result) => ({ ...nesting(result.leftData), total: result.total }));
      await measure(`deep-${depth}-diff-summary`, {
        action: 'diff', text: left, text2: right, includeData: false, retainSnapshot: true,
      }, (result) => ({ total: result.total, pathLength: result.diffs[0].leftPath.length }));
      const session = openWorker();
      try {
        const saved = await session.send({ action: 'diff', text: left, text2: right, includeData: false, retainSnapshot: true });
        if (!saved.message.ok) throw new Error(saved.message.error);
        const recovered = await session.send({ action: 'comparisonData', snapshotId: saved.message.result.snapshotId });
        rows.push({
          name: `deep-${depth}-comparisonData`, ok: recovered.message.ok, transportFallback: !!recovered.message.transportFallback,
          ...(recovered.message.ok ? nesting(recovered.message.result.leftData) : {
            event: recovered.message.event, error: recovered.message.error,
          }), roundTripMs: +recovered.elapsedMs.toFixed(2),
        });
      } finally { session.close(); }
      const documentSession = openWorker();
      try {
        // Compact output avoids allocating a quadratic-size pretty string for very deep JSON.
        const saved = await documentSession.send({ action: 'format', text: left, indent: null, includeData: false, retainSnapshot: true });
        if (!saved.message.ok) throw new Error(saved.message.error);
        const recovered = await documentSession.send({ action: 'parseSnapshot', snapshotId: saved.message.result.snapshotId });
        rows.push({
          name: `deep-${depth}-parseSnapshot`, ok: recovered.message.ok, transportFallback: !!recovered.message.transportFallback,
          ...(recovered.message.ok ? nesting(recovered.message.result.data) : {
            event: recovered.message.event, error: recovered.message.error,
          }), roundTripMs: +recovered.elapsedMs.toFixed(2),
        });
      } finally { documentSession.close(); }
      const parseTimes = [];
      for (let i = 0; i < 9; i++) {
        const start = performance.now();
        const parsed = JSON.parse(left);
        const elapsed = performance.now() - start;
        if (nesting(parsed).depth !== depth) throw new Error('Fallback JSON.parse changed nesting');
        if (i >= 2) parseTimes.push(elapsed);
      }
      rows.push({ name: `deep-${depth}-main-thread-JSON-parse-only`, inputKiB: +(left.length / 1024).toFixed(2), medianMs: median(parseTimes) });
    }
    const { createTaskRunner } = await import('/src/shared/worker-client.js');
    let clientWorker;
    const runTask = createTaskRunner({
      serialize: true,
      createWorker: () => (clientWorker = new Worker('/src/worker/index.js', { type: 'module' })),
    });
    try {
      const text = '{"child":'.repeat(20_000) + '0' + '}'.repeat(20_000);
      const deep = await runTask('parse', { text, retainSnapshot: true });
      const withoutSnapshot = await runTask('parse', { text });
      const next = await runTask('parse', { text: '{"alive":true}' });
      rows.push({
        name: 'client-continues-after-deep-response-with-and-without-snapshot',
        deepOk: deep.ok, deepDepth: deep.ok ? nesting(deep.result.data).depth : null,
        noSnapshotOk: withoutSnapshot.ok, noSnapshotError: withoutSnapshot.error,
        nextOk: next.ok, nextAlive: next.result?.data?.alive,
      });
      if (!deep.ok || nesting(deep.result.data).depth !== 20_000 || !withoutSnapshot.ok || !next.ok || !next.result.data.alive) {
        throw new Error('Client transfer recovery or later task failed');
      }
    } finally { clientWorker?.terminate(); }
    observer.disconnect();
    return rows;
  });
  console.log(JSON.stringify({ browser: browser.version(), root, results }, null, 2));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
