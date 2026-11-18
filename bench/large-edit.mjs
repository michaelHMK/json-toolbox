// node bench/browser.mjs --large-edit [path/to/single-line.json]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { formatJson } from '../src/core/json.js';

function makeFixture() {
  const bytes = 10 * 1024 * 1024;
  const row = '{"name":"测试用户","active":true,"payload":"' + 'x'.repeat(128) + '"}';
  const prefix = '{"records":[';
  const tail = '],"padding":"';
  const suffix = '"}';
  const available = bytes - Buffer.byteLength(prefix + tail + suffix);
  const count = Math.floor((available + 1) / Buffer.byteLength(row + ','));
  const text = prefix + Array(count).fill(row).join(',') + tail;
  return Buffer.from(text + 'x'.repeat(bytes - Buffer.byteLength(text + suffix)) + suffix);
}

// Capture the real event before the page handles it. Lazy editor creation and
// the first opportunity to paint are both included, without Playwright IPC.
async function measurePaint(page, target, eventType, perform) {
  await target.evaluate((element, type) => {
    window.editPaintMs = null;
    element.addEventListener(type, () => {
      const start = performance.now();
      function ready() {
        if (!document.querySelector('.large-input-editor .cm-content')?.isContentEditable) {
          requestAnimationFrame(ready);
        } else {
          requestAnimationFrame(() => { window.editPaintMs = performance.now() - start; });
        }
      }
      requestAnimationFrame(ready);
    }, { capture: true, once: true });
  }, eventType);
  await perform();
  await page.waitForFunction(() => window.editPaintMs !== null);
  return page.evaluate(() => Math.round(window.editPaintMs));
}

async function checkClipboard(page, expected) {
  const actual = await page.evaluate(async () => {
    const bytes = new TextEncoder().encode(await navigator.clipboard.readText());
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  });
  assert.equal(actual, createHash('sha256').update(expected).digest('hex'), 'full clipboard contents');
}

async function selectAndCopy(page, editor) {
  await editor.press('ControlOrMeta+A');
  await page.keyboard.press('ControlOrMeta+C');
}

async function verifyMiddleEdit(page, editor, sourceLength) {
  const scroller = page.locator('.large-input-editor .cm-scroller');
  await scroller.evaluate((element) => {
    element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2;
    return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  const scrollerBounds = await scroller.boundingBox();
  const line = await editor.locator('.cm-line').first().boundingBox();
  await page.mouse.click(scrollerBounds.x + scrollerBounds.width / 2, line.y + line.height / 2);
  const marker = 'LARGE_EDIT_MIDDLE_MARKER';
  await page.keyboard.insertText(marker);
  await selectAndCopy(page, editor);
  const offset = await page.evaluate(async (marker) => (await navigator.clipboard.readText()).indexOf(marker), marker);
  assert.ok(offset > sourceLength * 0.1 && offset < sourceLength * 0.9, 'edit in the interior of the single line');
  await page.keyboard.press('ControlOrMeta+Z');
}

export async function measureLargeEdits(browser, base, path) {
  const buffer = path ? await readFile(path) : makeFixture();
  const name = path ? basename(path) : 'generated-10MiB.min.json';
  const source = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  assert.ok(source.length > 256 * 1024 && !/[\r\n]/.test(source), 'expected a large single-line JSON fixture');
  JSON.parse(source);
  const edited = '[' + source + ',42]';
  const file = { name, mimeType: 'application/json', buffer };
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const rows = [];
  const errors = [];
  try {
    for (const tool of ['formatter', 'minify', 'escape', 'unescape', 'compare']) {
      const page = await context.newPage();
      page.setDefaultTimeout(60000);
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(base + '/' + tool + '.html');
      const compare = tool === 'compare';
      const input = page.locator(compare ? '#input-left' : '#input');
      const editor = page.locator('.large-input-editor .cm-content').first();
      const picker = page.locator(compare ? '#file-input-left' : '#file-input');
      const importToEditorMs = await measurePaint(page, picker, 'change', () => picker.setInputFiles(file));
      assert.ok(await input.isHidden());
      assert.equal(await input.inputValue(), '');
      const renderedChars = await editor.evaluate((element) => element.textContent.length);
      assert.ok(renderedChars < source.length / 2, 'single line should be rendered in a window');

      if (!compare) {
        // Unescape may report a diagnostic for a normal, unescaped JSON file.
        await page.waitForFunction(() => document.querySelector('#status').textContent || !document.querySelector('#error').hidden);
      }
      if (tool === 'formatter') await verifyMiddleEdit(page, editor, source.length);
      await editor.press('ControlOrMeta+Home');
      const keyMs = await measurePaint(page, editor, 'keydown', () => editor.press('['));
      await editor.press('ControlOrMeta+End');
      await page.keyboard.insertText(',42]');
      await selectAndCopy(page, editor);
      await checkClipboard(page, edited);

      if (compare) {
        // Comparing against the entire edited source catches loss of either
        // the imported body or an edit at the far end.
        await page.locator('#file-input-right').setInputFiles({ ...file, name: 'expected.json', buffer: Buffer.from(edited) });
        await page.waitForFunction(() => document.querySelector('#status').textContent.includes('diffIdenticalNote'));
      } else {
        let expected;
        if (tool === 'unescape') {
          // Replace the real imported file with a valid escaped copy, so the
          // successful unescape also has to handle the complete document.
          await page.evaluate((text) => navigator.clipboard.writeText(text), JSON.stringify(edited));
          await page.keyboard.press('ControlOrMeta+V');
          expected = edited;
        } else if (tool === 'escape') {
          expected = JSON.stringify(edited).slice(1, -1);
        } else {
          expected = formatJson(edited, { indent: tool === 'minify' ? null : '2' }).text;
        }
        // Observe a fresh completion even if the previous status has the
        // same translated label. All full-result checks occur after timing.
        await page.evaluate(() => {
          window.editFinished = false;
          const observer = new MutationObserver(() => { window.editFinished = true; observer.disconnect(); });
          observer.observe(document.querySelector('#status'), { childList: true });
        });
        await editor.press('ControlOrMeta+Enter');
        await page.waitForFunction(() => window.editFinished);
        await page.locator('#btn-copy').click();
        await page.waitForFunction(() => document.querySelector('#status').textContent === 'statusCopied');
        await checkClipboard(page, expected);
      }
      rows.push({ scenario: 'edit-' + tool, file: name, bytes: buffer.length, chars: source.length, importToEditorMs, keyMs, renderedChars });
      await page.close();
    }
    assert.deepEqual(errors, []);
    return rows;
  } finally {
    await context.close();
  }
}
