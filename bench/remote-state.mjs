// Dense structural diffs: keep large filter/expansion state out of scroll requests.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_EXECUTABLE=/path/to/chrome node bench/remote-state.mjs
// --baseline records an older implementation without enforcing the new protocol.
// Fixtures are constructed before browser measurement. Initial construction and
// Worker recovery are reported separately from the five scroll steps.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(process.cwd());
const baseline = process.argv.includes('--baseline');
const outputPath = process.env.REMOTE_STATE_OUTPUT;
const fullStateOperations = new Set(['init', 'update', 'recovery']);
const differences = 5000;
const depth = 20;
const left = [];
const right = [];
for (let i = 0; i < differences; i++) {
  let a = { v: 0 };
  let b = { v: 1 };
  for (let level = 0; level < depth; level++) { a = { nested: a }; b = { nested: b }; }
  left.push(a);
  right.push(b);
}
const leftText = JSON.stringify(left);
const rightText = JSON.stringify(right);
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/__remote-state.html') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><link rel="stylesheet" href="/styles/app.css"><div id="recovery-tree" style="position:relative;overflow:auto;width:800px;height:480px"></div>');
      return;
    }
    const file = resolve(root, '.' + pathname);
    if (!file.startsWith(root + '/')) throw new Error('Invalid path');
    response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' })[extname(file)] || 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const errors = [];
const phases = [];
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(60000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.remoteStateMessages = [];
    window.remoteStateReplies = [];
    window.remoteStateLongTasks = [];
    window.remoteStatePending = 0;
    window.remoteStatePhase = 'load';
    const NativeWorker = window.Worker;
    let nextWorker = 0;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.reviewId = ++nextWorker;
        this.reviewPending = new Map();
        this.addEventListener('message', ({ data }) => {
          if (data.treeChunk) return;
          const request = this.reviewPending.get(data.id);
          if (this.reviewPending.delete(data.id)) remoteStatePending--;
          remoteStateReplies.push({ phase: remoteStatePhase, worker: this.reviewId,
            operation: request?.operation, side: request?.side, ok: data.ok, code: data.code,
            rows: data.result?.rows?.length, rowCount: data.result?.rowCount,
            nestedRowValue: data.result?.rows?.some((row) => row.value && typeof row.value === 'object' && Object.keys(row.value).length > 0) || false,
          });
        });
      }
      postMessage(message, ...args) {
        const started = performance.now();
        super.postMessage(message, ...args);
        const elapsedMs = performance.now() - started;
        this.reviewPending.set(message.id, { operation: message.operation, side: message.side });
        remoteStatePending++;
        remoteStateMessages.push({ phase: remoteStatePhase, worker: this.reviewId,
          action: message.action, operation: message.operation, side: message.side,
          hasOptions: Object.hasOwn(message, 'options'),
          requiredChildren: message.options?.requiredChildren?.size ?? 0,
          forceExpand: message.options?.forceExpand?.size ?? 0, elapsedMs,
        });
      }
      terminate() {
        remoteStatePending -= this.reviewPending.size;
        this.reviewPending.clear();
        return super.terminate();
      }
    };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) remoteStateLongTasks.push({ started: entry.startTime, duration: entry.duration });
    }).observe({ type: 'longtask', buffered: true });
  });
  const frames = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const settle = async () => {
    await page.waitForFunction(() => window.remoteStatePending === 0 &&
      (!document.getElementById('busy') || document.getElementById('busy').hidden) &&
      !document.querySelector('.virtual-placeholder'));
    await frames();
  };
  const mark = (name) => page.evaluate((name) => { remoteStatePhase = name; return performance.now(); }, name);
  const capture = async (name, started) => {
    await frames();
    const result = await page.evaluate(({ name, started }) => {
      const messages = remoteStateMessages.filter((message) => message.phase === name);
      const replies = remoteStateReplies.filter((reply) => reply.phase === name);
      const longTasks = remoteStateLongTasks.filter((task) => task.started >= started).map((task) => task.duration);
      return { name, messages, replies, longTasksMs: longTasks,
        maxLongTaskMs: Math.max(0, ...longTasks), maxPostMessageMs: Math.max(0, ...messages.map((message) => message.elapsedMs)),
        domEntries: [...document.querySelectorAll('.virtual-tree')].map((tree) => tree.querySelectorAll('.entry').length),
        placeholders: document.querySelectorAll('.virtual-placeholder').length,
      };
    }, { name, started });
    phases.push(result);
    return result;
  };

  await page.goto(base + '/compare.html');
  await frames();
  let started = await mark('initial-construction');
  await page.locator('#file-input-left').setInputFiles({ name: 'left.json', mimeType: 'application/json', buffer: Buffer.from(leftText) });
  await page.locator('#file-input-right').setInputFiles({ name: 'right.json', mimeType: 'application/json', buffer: Buffer.from(rightText) });
  await page.waitForSelector('#tree-left .entry.current');
  await settle();
  const initial = await capture('initial-construction', started);
  assert.ok(initial.messages.some((message) => message.requiredChildren === 105001), 'fixture must preserve the reviewed 105,001-entry filter index');

  started = await mark('dense-diff-scroll');
  for (let step = 1; step <= 5; step++) {
    await page.locator('#tree-left').evaluate((tree, top) => { tree.scrollTop = top; }, step * 100000);
    await page.waitForTimeout(500);
    await settle();
  }
  const scroll = await capture('dense-diff-scroll', started);
  assert.ok(scroll.messages.filter((message) => message.operation === 'rows').length >= 10, 'both sides must fetch uncached rows on all five scrolls');
  if (!baseline) {
    assert.ok(scroll.maxLongTaskMs < 50, 'scrolling must have no main-thread task of 50 ms or longer');
    assert.ok(scroll.messages.every((message) => !message.hasOptions), 'scroll requests must not clone complete tree state');
  }
  assert.equal(scroll.placeholders, 0);
  assert.ok(scroll.domEntries.every((count) => count < 100), 'DOM stays bounded independently of the 5000 differences');

  started = await mark('tree-interactions');
  await page.locator('#diff-next').click();
  await settle();
  await page.locator('#diff-prev').click();
  await settle();
  const parentPath = '/0' + '/nested'.repeat(depth);
  const toggle = page.locator(`#tree-left .entry[role="treeitem"][data-path="${parentPath}"] .toggle`);
  await toggle.click();
  await settle();
  await toggle.click();
  await settle();
  await page.locator('#tree-left').focus();
  await page.keyboard.press('ArrowDown');
  await settle();
  const interactions = await capture('tree-interactions', started);
  for (const operation of ['reveal', 'setOpen', 'move']) assert.ok(interactions.messages.some((message) => message.operation === operation));

  // Exercise the compare page's actual cancellation/recovery boundary as well:
  // the expected missing-model handshake must not leave a user-visible error.
  await page.locator('#only-diff').check();
  await settle();
  await toggle.click();
  await settle();
  const expectedCounts = await page.evaluate(() => Object.fromEntries(['left', 'right'].map((side) =>
    [side, remoteStateReplies.findLast((reply) => reply.side === side && reply.rowCount !== undefined).rowCount])));
  started = await mark('comparison-page-recovery');
  await page.locator('#btn-cancel').evaluate((button) => button.click());
  await page.locator('#tree-left').evaluate((tree) => { tree.scrollTop = 600000; });
  await page.waitForTimeout(500);
  await settle();
  const pageRecovery = await capture('comparison-page-recovery', started);
  assert.equal(await page.locator('#only-diff').isChecked(), true);
  assert.equal(await page.locator('#error').isHidden(), true, 'successful Worker recovery must not display its internal handshake error');
  for (const side of ['left', 'right']) {
    const last = pageRecovery.replies.findLast((reply) => reply.side === side && reply.rowCount !== undefined);
    assert.ok(last, `the ${side} tree must load from the replacement Worker`);
    assert.equal(last.rowCount, expectedCounts[side], 'filtering and manual collapse survive page recovery');
  }
  if (!baseline) {
    assert.equal(pageRecovery.replies.filter((reply) => reply.code === 'TREE_MODEL_UNAVAILABLE').length, 2);
    assert.equal(pageRecovery.messages.filter((message) => message.hasOptions).length, 2, 'each comparison side restores its complete state once');
  }

  // Real module Worker cancellation/recreation; no private page state is exposed.
  // This fixture adds unchanged branches so a lost onlyRequired option is visible.
  await page.goto(base + '/__remote-state.html');
  const recovery = await page.evaluate(async () => {
    const [{ createRemoteTree }, { createTaskRunner }, { createChildPathIndex }] = await Promise.all([
      import('/src/shared/remote-tree.js'), import('/src/shared/worker-client.js'), import('/src/shared/json-tree.js'),
    ]);
    const source = JSON.stringify({ branch: { child: { n: 1 }, hidden: 99 },
      rows: Array.from({ length: 20000 }, () => ({ n: 1, hidden: 99 })), ignored: true });
    const expanded = new Set();
    const collapsed = new Set();
    const requiredChildren = createChildPathIndex(['/branch/child/n', '/rows/5/n', '/rows/19000/n']);
    let snapshotId = null;
    let parsing = null;
    const run = createTaskRunner({ serialize: true, onReset: () => { snapshotId = null; parsing = null; } });
    const request = async (payload) => {
      if (snapshotId === null) {
        parsing ||= run('parse', { text: source, includeData: false, retainSnapshot: true });
        const parsed = await parsing;
        if (!parsed.ok) return parsed;
        snapshotId = parsed.result.snapshotId;
        parsing = null;
      }
      return run('tree', { ...payload, kind: 'document', snapshotId });
    };
    remoteStatePhase = 'recovery-setup';
    const tree = createRemoteTree(document.getElementById('recovery-tree'), { request,
      expanded, collapsed, onlyRequired: true, requiredChildren,
      forceExpand: new Set(['/branch', '/branch/child', '/rows']),
    });
    try {
      await tree.ready;
      await tree.setOpen('/branch', false);
      await tree.setOpen('/rows/19000', true);
      const beforeCount = tree.rowCount;
      run.cancel();
      remoteStatePhase = 'worker-recovery';
      await tree.setOpen('/rows/5', true);
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const entries = [...document.querySelectorAll('#recovery-tree .entry[role="treeitem"]')];
      return { beforeCount, afterCount: tree.rowCount,
        paths: entries.map((entry) => entry.dataset.path),
        branchOpen: entries.find((entry) => entry.dataset.path === '/branch')?.getAttribute('aria-expanded'),
        retainedManualExpansion: expanded.has('/rows/19000'),
        retainedManualCollapse: collapsed.has('/branch'),
        messages: remoteStateMessages.filter((message) => message.phase === 'worker-recovery'),
        replies: remoteStateReplies.filter((reply) => reply.phase === 'worker-recovery'),
      };
    } finally { tree.destroy(); run.cancel(); }
  });
  assert.equal(recovery.branchOpen, 'false');
  assert.equal(recovery.retainedManualExpansion, true);
  assert.equal(recovery.retainedManualCollapse, true);
  assert.equal(recovery.afterCount, recovery.beforeCount + 2, 'opening one filtered child adds its value and close row');
  assert.ok(recovery.paths.includes('/rows/19000/n'));
  assert.ok(recovery.paths.includes('/rows/5/n'));
  assert.ok(!recovery.paths.includes('/ignored') && !recovery.paths.includes('/branch/child'));
  if (!baseline) {
    assert.ok(recovery.replies.some((reply) => reply.code === 'TREE_MODEL_UNAVAILABLE'));
    assert.equal(recovery.messages.filter((message) => message.hasOptions).length, 1, 'a replacement Worker receives one full-state recovery');
    for (const phase of phases) for (const message of phase.messages) {
      if (message.action === 'tree' && !fullStateOperations.has(message.operation)) assert.equal(message.hasOptions, false, `${message.operation} must carry only its incremental payload`);
    }
    for (const message of recovery.messages) {
      if (message.hasOptions) assert.ok(fullStateOperations.has(message.operation));
    }
  }
  for (const reply of [...phases.flatMap((phase) => phase.replies), ...recovery.replies]) {
    if (reply.rows !== undefined) assert.ok(reply.rows <= 256);
    assert.equal(reply.nestedRowValue, false);
  }
  assert.deepEqual(errors, []);
  const result = { browser: browser.version(), mode: baseline ? 'baseline' : 'regression',
    fixture: { differences, depth, leftCharacters: leftText.length, rightCharacters: rightText.length, requiredChildren: 105001 },
    note: 'Long Task API reports tasks >=50 ms; zero means none observed. Construction/recovery are excluded from the scroll budget. Local HTTP omits extension startup/i18n.',
    phases, recovery, errors,
  };
  if (outputPath) await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
