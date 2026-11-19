// Run against the ZIP produced by scripts/build_release.py, using full Chromium.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const [archive, ...extra] = process.argv.slice(2);
assert.ok(archive && !extra.length, 'Usage: node bench/release-smoke.mjs dist/json-toolbox-<version>.zip');
const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
assert.equal((await readFile(archive + '.sha256', 'utf8')).trimEnd(), digest + '  ' + basename(archive));

const temp = await mkdtemp(join(tmpdir(), 'json-toolbox-release-'));
const extension = join(temp, 'extension');
let context;
try {
  execFileSync('python3', ['-m', 'zipfile', '-e', archive, extension]);
  context = await chromium.launchPersistentContext(join(temp, 'profile'), {
    channel: 'chromium',
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const isBackground = (worker) => /^chrome-extension:\/\/[^/]+\/background\.js$/.test(worker.url());
  const background = context.serviceWorkers().find(isBackground)
    || await context.waitForEvent('serviceworker', { predicate: isBackground, timeout: 20000 });
  const base = await background.evaluate(() => chrome.runtime.getURL(''));
  const page = await context.newPage();
  const errors = [];
  await page.addInitScript(() => {
    window.__smokeWindowErrors = [];
    window.addEventListener('error', (event) => {
      if (event.message) window.__smokeWindowErrors.push(event.message);
    });
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

  const input = '{ "units": 7 }';
  const escaped = JSON.stringify(input).slice(1, -1);
  for (const [tool, source, output] of [
    ['formatter', input, JSON.stringify(JSON.parse(input), null, 2)],
    ['minify', input, '{"units":7}'],
    ['escape', input, escaped],
    ['unescape', escaped, input],
  ]) {
    await page.goto(base + tool + '.html');
    await page.locator('#input').fill(source);
    await page.locator(tool === 'formatter' ? '#btn-format' : '#btn-run').click();
    await page.waitForFunction((expected) => document.querySelector('#output-text').textContent === expected, output);
  }

  // Exercise lazy CodeMirror loading under the packaged extension's strict CSP.
  await page.goto(base + 'formatter.html');
  await page.locator('#file-input').setInputFiles({
    name: 'large.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{ "cspCheck": true }' + ' '.repeat(256 * 1024)),
  });
  await page.locator('.large-input-editor .cm-content').waitFor();
  await page.waitForFunction(() => document.querySelector('#output-text').textContent.includes('"cspCheck": true'));

  await page.goto(base + 'compare.html');
  await page.locator('#input-left').fill(input);
  await page.locator('#input-right').fill('{"units":8,"wide":"' + 'x'.repeat(200) + '"}');
  await page.locator('#btn-compare').click();
  for (const [side, value] of [['left', '7'], ['right', '8']]) {
    const change = page.locator(`#tree-${side} .entry.current[data-path="/units"]`);
    await change.waitFor();
    assert.ok((await change.textContent()).includes(value));
  }
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  errors.push(...await page.evaluate(() => window.__smokeWindowErrors));
  assert.deepEqual(errors, []);
  console.log(`✓ ${basename(archive)}: background worker and five extension pages passed`);
} finally {
  await context?.close();
  await rm(temp, { recursive: true, force: true });
}
