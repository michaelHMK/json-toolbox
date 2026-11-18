// Actual component + page integration checks. All assertions always run.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_EXECUTABLE=/path/to/chromium node bench/text-view.mjs
// Component timings are single-run smoke measurements, not the candidate medians
// from text-rendering.mjs. No extension APIs or network services are required.
import { resolveExtension } from './extension-root.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { root, moduleBase } = resolveExtension();
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/__text_bench__') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><link rel="stylesheet" href="/styles/app.css"><pre id="output-text" style="width:800px;height:500px"></pre>');
    return;
  }
  try {
    const file = resolve(root, '.' + pathname);
    if (!file.startsWith(root + '/')) throw new Error('Invalid path');
    response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' })[extname(file)] || 'text/plain');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE,
  ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--disable-features=OverlayScrollbar'],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const results = [];
const settle = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const goToEnd = async (selector = '#output-text') => {
  await page.locator(selector).focus();
  await page.keyboard.press('Control+End');
  await settle();
};

const visibleMarker = async (selector, marker) => {
  const left = await page.evaluate(({ selector, marker }) => {
    const element = document.querySelector(selector);
    const viewport = element.getBoundingClientRect();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const start = node.textContent.indexOf(marker);
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + marker.length);
      const rect = range.getBoundingClientRect();
      if (rect.left >= viewport.left - 1 && rect.right <= viewport.right + 1 &&
          rect.top >= viewport.top - 1 && rect.bottom <= viewport.bottom + 1) return rect.left;
    }
    return null;
  }, { selector, marker });
  assert.notEqual(left, null, `${marker} must be in the viewport, not merely an overscan row`);
  return left;
};

try {
  await page.goto(base + '/__text_bench__');
  await page.evaluate(async (moduleBase) => {
    const { createVirtualTextView } = await import(moduleBase + 'shared/virtual-text.js');
    window.output = document.querySelector('#output-text');
    window.resizeErrors = [];
    window.addEventListener('error', (event) => {
      if (event.message?.startsWith('ResizeObserver loop')) resizeErrors.push(event.message);
    });
    window.textView = createVirtualTextView(output);
    textView.setText('small 中文 😀');
  }, moduleBase);
  assert.equal(await page.locator('#output-text').textContent(), 'small 中文 😀');
  for (const scenario of ['100000-lines', '5MiB-single-line', 'unicode-tab-line', '2000000-lines']) {
    const measurement = await page.evaluate((scenario) => {
      window.source = scenario === '100000-lines'
        ? Array.from({ length: 100000 }, (_, i) => `  {"id":${i},"name":"Record ${i}","active":true,"payload":"abcdefghijklmnopqrstuvwxyz0123456789"},`).join('\n')
        : scenario === '5MiB-single-line' ? 'BEGIN' + 'x'.repeat(5 * 1024 * 1024) + 'ENDMARK'
          : scenario === 'unicode-tab-line' ? ('前🙂\t' + 'x'.repeat(124)).repeat(8192) + '末尾终'
            : 'row\n'.repeat(2000000) + 'FINALROW';
      const start = performance.now();
      textView.setText(source);
      // Drag to the edge immediately after the result appears.
      if (scenario === 'unicode-tab-line') output.scrollLeft = output.scrollWidth;
      const scrollHeight = output.scrollHeight;
      return { bytes: source.length, setupAndLayoutMs: +(performance.now() - start).toFixed(2),
        elements: output.querySelectorAll('*').length, scrollHeight, scrollWidth: output.scrollWidth };
    }, scenario);
    if (scenario === 'unicode-tab-line') await settle();
    else await goToEnd();
    const end = await page.evaluate(() => ({ text: output.textContent, elements: output.querySelectorAll('*').length }));
    const marker = scenario === '100000-lines' ? 'Record 99999' : scenario === '5MiB-single-line' ? 'ENDMARK'
      : scenario === 'unicode-tab-line' ? '末尾终' : 'FINALROW';
    assert.ok(end.text.includes(marker), `end marker missing: ${scenario}`);
    assert.ok(end.elements < 150);
    const markerLeft = await visibleMarker('#output-text', marker);
    if (scenario === 'unicode-tab-line') {
      const releasedAt = await page.evaluate(() => output.scrollLeft);
      await settle();
      assert.equal(await page.evaluate(() => output.scrollLeft), releasedAt, 'released scrollbar must stay still');
      assert.ok(Math.abs(await visibleMarker('#output-text', marker) - markerLeft) <= 1, 'line end must stay still');
      await page.evaluate(() => { output.style.width = '700px'; });
      await settle();
      await visibleMarker('#output-text', marker);
      await page.evaluate(() => { output.style.width = '800px'; });
      await settle();
    }
    const copiedComplete = await page.evaluate(() => {
      output.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
      const clipboardData = new DataTransfer();
      output.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }));
      return clipboardData.getData('text/plain') === source;
    });
    assert.ok(copiedComplete);
    results.push({ scenario, ...measurement, endElements: end.elements, copiedComplete });
    if (scenario === '5MiB-single-line') {
      assert.ok(await page.evaluate(() => output.offsetHeight > output.clientHeight), 'horizontal scrollbar occupies layout space');
      await page.evaluate(() => { output.style.height = '300px'; });
      await settle();
      await page.evaluate(() => { output.style.height = '500px'; });
      await settle();
      assert.deepEqual(await page.evaluate(() => resizeErrors), [], 'resizing the output must settle without observer errors');
    }
  }
  for (const text of ['a\u0301'.repeat(10000) + 'COMBINING_END',
    'a\u0301'.repeat(10000) + 'FIRST_END\n' + 'e\u0301'.repeat(10000) + 'COMBINING_END',
    '👨‍👩‍👧‍👦'.repeat(10000) + 'COMBINING_END']) {
    await page.evaluate((text) => { textView.setText(text); output.scrollLeft = output.scrollWidth; }, text);
    await page.waitForFunction(() => output.textContent.includes('COMBINING_END'));
    await visibleMarker('#output-text', 'COMBINING_END');
    await page.evaluate(() => textView.refresh());
    await settle();
    await visibleMarker('#output-text', 'COMBINING_END');
  }
  // This many code units need virtualization, but their glyphs fit on one screen.
  await page.evaluate(() => textView.setText('BEGIN' + ('a' + '\u0301'.repeat(299)).repeat(55) + 'END'));
  await page.waitForFunction(() => output.scrollWidth === output.clientWidth && output.textContent.endsWith('END'));
  await visibleMarker('#output-text', 'BEGIN');
  await visibleMarker('#output-text', 'END');
  // Ctrl+End locates the end of the last row even as a wider row above it
  // grows the scrollbar. A subsequent native scroll can still reach that row.
  for (const jump of ['Ctrl+End', 'revealPosition']) {
    const lastRowWidth = await page.evaluate((jump) => {
      const source = '宽'.repeat(1000000) + 'WIDE_END\n' + '末'.repeat(100000) + 'LAST_END';
      textView.clear();
      textView.setText(source);
      if (jump === 'Ctrl+End') output.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', ctrlKey: true, bubbles: true }));
      else textView.revealPosition(source.length - 1);
      return output.scrollWidth;
    }, jump);
    await page.waitForFunction((width) => output.scrollWidth > width * 2, lastRowWidth);
    await visibleMarker('#output-text', 'LAST_END');
    if (jump === 'revealPosition') assert.equal(await page.evaluate(() => document.getSelection().toString()), 'D');
  }
  await page.evaluate(() => { output.scrollLeft = output.scrollWidth; });
  await page.waitForFunction(() => output.textContent.includes('WIDE_END'));
  await visibleMarker('#output-text', 'WIDE_END');
  // The first 1024 code units take only a few pixels. Later frames must
  // fill the viewport and keep an explicitly revealed selection at its offset.
  await page.evaluate(() => {
    const prefix = ('a' + '\u0301'.repeat(31)).repeat(1024);
    textView.setText(prefix + '選' + '中'.repeat(2000000) + '\n' + prefix + 'NEXT_ROW');
    textView.revealPosition(prefix.length);
  });
  await page.waitForFunction(() => output.textContent.includes('NEXT_ROW'));
  await visibleMarker('#output-text', 'NEXT_ROW');
  assert.equal(await page.evaluate(() => document.getSelection().toString()), '選');
  await page.evaluate(() => { output.hidden = true; textView.setText('a\n'.repeat(5000) + 'HIDDENEND'); });
  assert.equal(await page.locator('.virtual-text-row').count(), 0);
  await page.evaluate(() => { output.hidden = false; textView.refresh(); });
  assert.ok(await page.locator('.virtual-text-row').count() > 0);
  await page.setViewportSize({ width: 900, height: 700 });
  await goToEnd();
  assert.match(await page.locator('#output-text').textContent(), /HIDDENEND/);
  await page.evaluate(() => textView.setDiff({
    aText: Array.from({ length: 60000 }, (_, i) => `left ${i}`).join('\n'),
    bText: Array.from({ length: 60000 }, (_, i) => `right ${i}`).join('\n'),
    ops: [{ type: 'del', aStart: 0, count: 60000 }, { type: 'add', bStart: 0, count: 60000 }], blocky: true,
  }));
  await goToEnd();
  assert.match(await page.locator('#output-text').textContent(), /right 59999/);
  await visibleMarker('#output-text', 'right 59999');
  assert.ok(await page.locator('.virtual-text-row').count() < 100);
  await page.evaluate(() => textView.clear());
  assert.equal(await page.locator('#output-text').textContent(), '');

  // Exercise production page handlers, Worker snapshots and view switching.
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(base + '/formatter.html');
  await page.evaluate(() => {
    const data = Array(50000).fill('ordinary'); data[data.length - 1] = 'FORMAT_END';
    document.querySelector('#input').value = JSON.stringify(data);
    document.querySelector('#btn-format').click();
  });
  await page.waitForSelector('#output-text.virtual-text');
  await goToEnd();
  assert.match(await page.locator('#output-text').textContent(), /FORMAT_END/);
  await page.locator('#view-tree').click();
  await page.waitForSelector('#tree.virtual-tree');
  await page.locator('#view-text').click();
  await goToEnd();
  assert.match(await page.locator('#output-text').textContent(), /FORMAT_END/);
  await page.locator('#btn-clear').click();
  assert.equal(await page.locator('#output-text').textContent(), '');

  await page.goto(base + '/minify.html');
  await page.evaluate(() => {
    window.expectedOutput = '"BEGIN' + 'x'.repeat(5 * 1024 * 1024) + 'MINIFY_END"';
    navigator.clipboard.writeText = async (text) => { window.copied = text; };
    document.querySelector('#input').value = expectedOutput;
    document.querySelector('#btn-run').click();
  });
  await page.waitForSelector('#output-text.virtual-text');
  await goToEnd();
  assert.match(await page.locator('#output-text').textContent(), /MINIFY_END/);
  await visibleMarker('#output-text', 'MINIFY_END');
  await page.locator('#btn-copy').click();
  assert.ok(await page.evaluate(() => copied === expectedOutput));

  await page.goto(base + '/compare.html');
  await page.evaluate(() => {
    const left = Array(60000).fill(1);
    const right = Array(60000).fill(2); right[right.length - 1] = 'TEXT_DIFF_END';
    document.querySelector('#input-left').value = JSON.stringify(left);
    document.querySelector('#input-right').value = JSON.stringify(right);
    document.querySelector('#btn-compare').click();
  });
  await page.waitForFunction(() => !document.querySelector('#result').hidden);
  await page.locator('#view-text').click();
  await page.waitForSelector('#text-view.virtual-text');
  await goToEnd('#text-view');
  assert.match(await page.locator('#text-view').textContent(), /TEXT_DIFF_END/);
  await visibleMarker('#text-view', 'TEXT_DIFF_END');
  assert.ok(await page.locator('#text-view .virtual-text-row').count() < 100);
  await page.locator('#view-struct').click();
  await page.locator('#view-text').click();
  await goToEnd('#text-view');
  assert.match(await page.locator('#text-view').textContent(), /TEXT_DIFF_END/);
  await visibleMarker('#text-view', 'TEXT_DIFF_END');
  await page.locator('#btn-clear').click();
  assert.equal(await page.locator('#text-view').textContent(), '');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: browser.version(), componentResults: results,
    verified: ['120000 diff rows', 'Unicode/tabs/combining marks', 'scrollbar right edge', 'Ctrl+End', 'complete copy', 'hidden/show', 'resize', 'clear',
      'formatter tree/text switch', 'minify full copy button', 'compare beyond 50000 rows'] }, null, 2));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
