// Optional browser test: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs
// CHROMIUM_EXECUTABLE=/path/to/chrome node bench/auto-format.mjs
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const projectRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const srcDir = join(projectRoot, 'src');

const temp = await mkdtemp(join(tmpdir(), 'json-toolbox-auto-format-'));
const extCopy = join(temp, 'ext');
const profile = join(temp, 'profile');
let context;

try {
  await cp(srcDir, extCopy, { recursive: true });
  const manifestPath = join(extCopy, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  // Grant host_permissions only in this temporary test copy to exercise automatic injection.
  manifest.host_permissions = ['http://*/*', 'https://*/*'];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE,
    args: [`--disable-extensions-except=${extCopy}`, `--load-extension=${extCopy}`],
  });

  const isBg = (w) => /^chrome-extension:\/\/[^/]+\/background\.js$/.test(w.url());
  const bg = context.serviceWorkers().find(isBg)
    || await context.waitForEvent('serviceworker', { predicate: isBg, timeout: 20000 });
  await bg.evaluate(() => syncAutoFormatScript());

  const smallBody = '{"name":"json-toolbox","precision":9007199254740993,"nested":{"ok":true,"items":["a","b"]}}';
  const chunk50 = JSON.stringify({ id: 1, label: 'auto-format-item', tags: ['alpha', 'beta'], decimal: 1.25 });
  const count50 = Math.ceil((50 * 1024 * 1024) / (chunk50.length + 1));
  const large50Body = '[' + Array(count50).fill(chunk50).join(',') + ']';

  await context.route('https://api.example.com/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/small.json') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: smallBody });
    } else if (pathname === '/large50.json') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: large50Body });
    } else if (pathname === '/csp.json') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Content-Security-Policy': "default-src 'none'; frame-src 'none'; script-src 'none'" },
        body: '{"csp":"ok"}',
      });
    } else if (pathname === '/coep.json') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' },
        body: '{"coep":"blocked"}',
      });
    } else if (pathname === '/invalid.json') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{invalid json' });
    } else if (pathname === '/plain.txt') {
      await route.fulfill({ status: 200, contentType: 'text/plain', body: '{"plain":true}' });
    } else {
      await route.fulfill({ status: 404, body: 'Not found' });
    }
  });

  const page = await context.newPage();

  async function waitViewerFrame(p) {
    await p.waitForSelector('#json-toolbox-viewer-host');
    await p.waitForFunction(() => {
      const host = document.querySelector('#json-toolbox-viewer-host');
      return host && getComputedStyle(host).visibility === 'visible';
    });
    const frame = p.frames().find((f) => f.url().includes('/viewer.html'));
    assert.ok(frame, 'viewer.html iframe must be present');
    await frame.waitForSelector('#tree .entry');
    return frame;
  }

  // 1. 1 KB JSON: tree view, Raw/Formatted toggle, Open in JSON Toolbox
  await page.goto('https://api.example.com/small.json');
  const smallFrame = await waitViewerFrame(page);
  assert.ok((await smallFrame.locator('#tree').textContent()).includes('9007199254740993'));
  await smallFrame.locator('#view-text').click();
  await smallFrame.waitForFunction(() => !document.querySelector('#output-text').hidden);
  assert.equal(await smallFrame.locator('#output-text').textContent(), smallBody);
  await smallFrame.locator('#view-tree').click();
  await smallFrame.waitForFunction(() => !document.querySelector('#tree').hidden);

  const [toolboxTab] = await Promise.all([
    context.waitForEvent('page'),
    smallFrame.locator('#btn-open-toolbox').click(),
  ]);
  await toolboxTab.waitForLoadState('domcontentloaded');
  await toolboxTab.waitForFunction(() => document.querySelector('#output-text')?.textContent?.includes('9007199254740993'));
  await toolboxTab.close();

  // 2. Strict CSP page still renders D1-A iframe cleanly
  await page.goto('https://api.example.com/csp.json');
  const cspFrame = await waitViewerFrame(page);
  assert.ok((await cspFrame.locator('#tree').textContent()).includes('"ok"'));

  // 3. COEP require-corp degrades gracefully to fallback banner + keeps raw <pre> visible
  await page.goto('https://api.example.com/coep.json');
  await page.waitForFunction(() => {
    const host = document.querySelector('#json-toolbox-viewer-host');
    return host?.dataset?.fallback === 'true';
  });
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('pre')).display !== 'none'), true);

  // 4. Invalid JSON stays completely untouched
  await page.goto('https://api.example.com/invalid.json');
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#json-toolbox-viewer-host').count(), 0);
  assert.equal(await page.locator('pre').textContent(), '{invalid json');

  // 5. text/plain respects D4 toggle (off by default, works when enabled)
  await page.goto('https://api.example.com/plain.txt');
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#json-toolbox-viewer-host').count(), 0);
  await bg.evaluate(() => chrome.storage.local.set({ formatPlainText: true }));
  await page.reload();
  const plainFrame = await waitViewerFrame(page);
  assert.ok((await plainFrame.locator('#tree').textContent()).includes('true'));

  // 6. 50 MiB JSON: renders virtualized tree cleanly with bounded DOM and measured main-thread timing
  const largePage = await context.newPage();
  await largePage.addInitScript(() => {
    window.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__longTasks.push(entry.duration);
    }).observe({ type: 'longtask', buffered: true });
  });
  const t0 = performance.now();
  await largePage.goto('https://api.example.com/large50.json');
  const largeFrame = await waitViewerFrame(largePage);
  const largeMs = +(performance.now() - t0).toFixed(1);
  const largeEntries = await largeFrame.locator('#tree .entry').count();
  assert.ok(largeEntries > 0 && largeEntries <= 80, `Virtualized tree bounded (${largeEntries})`);
  // Switching to Raw view on 50 MiB uses Worker-built lineIndex and avoids main-thread stalls.
  await largeFrame.locator('#view-text').click();
  await largeFrame.waitForFunction(() => !document.querySelector('#output-text').hidden);
  const longTasks = await largePage.evaluate(() => window.__longTasks);
  await largePage.close();

  const maxLongTaskMs = longTasks.length ? +Math.max(...longTasks).toFixed(1) : 0;
  const maxBudgetMs = Number(process.env.AUTO_FORMAT_MAX_LONG_TASK_MS || 1000);
  assert.ok(maxLongTaskMs <= maxBudgetMs, `50 MiB auto-format long task ${maxLongTaskMs}ms exceeded budget ${maxBudgetMs}ms`);

  console.log(JSON.stringify({
    ok: true,
    large50MiBMs: largeMs,
    largeEntries,
    longTasksCount: longTasks.length,
    maxLongTaskMs,
    maxBudgetMs,
  }, null, 2));
} finally {
  await context?.close();
  await rm(temp, { recursive: true, force: true });
}
