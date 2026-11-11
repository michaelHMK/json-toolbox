// Generate localized promotional images and screenshots of the real extension.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
// CHROMIUM_EXECUTABLE=/path/to/full/chromium node store-assets/generate.mjs
// Optional: STORE_LOCALES=en,zh_CN to regenerate selected locales only.
// Extension loading requires full Chromium, not chrome-headless-shell.
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writePromoSources } from './promos.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assets = dirname(fileURLToPath(import.meta.url));
const root = resolve(assets, '..');
const executablePath = process.env.CHROMIUM_EXECUTABLE;
const available = (await readdir(join(root, '_locales'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
const locales = process.env.STORE_LOCALES
  ? [...new Set(process.env.STORE_LOCALES.split(',').map((locale) => locale.trim()))]
  : available;
assert(locales.length && locales.every((locale) => available.includes(locale)),
  `STORE_LOCALES must use catalog directories: ${available.join(', ')}`);
const output = [];

async function capture(page, name, width, height) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.mouse.move(0, 0);
  const path = join(assets, name);
  await page.screenshot({ path, animations: 'disabled', caret: 'hide' });
  const png = await readFile(path);
  assert.equal(png.readUInt32BE(16), width, `${name}: width`);
  assert.equal(png.readUInt32BE(20), height, `${name}: height`);
  output.push({ file: name, width, height });
}

async function verifyCatalog(page, catalog, locale) {
  const result = await page.evaluate((catalog) => {
    const substitutions = ['101', '202', '303', '404', '505'];
    const mismatches = [];
    for (const [key, entry] of Object.entries(catalog)) {
      const expected = entry.message.replace(/\$([a-z][a-z0-9_]*)\$/gi, (_, name) => {
        const content = entry.placeholders[name.toLowerCase()].content;
        return content.replace(/\$(\d+)/g, (_, index) => substitutions[Number(index) - 1]);
      });
      const actual = chrome.i18n.getMessage(key, substitutions);
      if (actual !== expected) mismatches.push({ key, expected, actual });
    }
    return {
      language: chrome.i18n.getUILanguage(),
      uiLocale: chrome.i18n.getMessage('@@ui_locale'),
      mismatches,
    };
  }, catalog);
  // UI locale can be normalized (es -> es-ES, zh_HK -> zh_TW).
  // Verify the actual messages, including regional variants, instead of the tag.
  assert.deepEqual(result.mismatches, [], `${locale}: native extension translations`);
  console.log(`${locale}: browser=${result.language}, UI=${result.uiLocale}, ${Object.keys(catalog).length} messages verified`);
}

async function verifyPage(page, catalog) {
  assert.equal(await page.locator('#error').isVisible(), false);
  const problems = await page.evaluate((catalog) => {
    const problems = [];
    for (const [attribute, property] of [
      ['data-i18n', 'textContent'], ['data-i18n-title', 'title'], ['data-i18n-placeholder', 'placeholder'],
    ]) {
      for (const element of document.querySelectorAll(`[${attribute}]`)) {
        const key = element.getAttribute(attribute);
        if (element[property] !== catalog[key].message) problems.push(`${key}: incorrect ${property}`);
      }
    }
    if (document.documentElement.scrollWidth > innerWidth) problems.push('Horizontal page overflow');
    for (const element of document.querySelectorAll('button, .nav-link, .page-heading, .field')) {
      if (!element.checkVisibility()) continue;
      const rect = element.getBoundingClientRect();
      if (rect.left < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1) {
        problems.push(`Control outside viewport: ${element.id || element.textContent.trim()}`);
      }
    }
    return problems;
  }, catalog);
  assert.deepEqual(problems, [], `Localized page: ${page.url()}`);
}

async function waitForOutput(page) {
  await page.waitForFunction(() => document.querySelector('#busy').hidden && document.querySelector('#output-text').textContent);
}

async function importJson(page, name, source) {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#btn-import').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name, mimeType: 'application/json', buffer: Buffer.from(source, 'utf8') });
  await waitForOutput(page);
  assert.equal(await page.locator('#input').inputValue(), source);
  assert.match(await page.locator('#file-name').textContent(), new RegExp(`^${name.replace('.', '\\.')} · `));
  assert.equal(await page.locator('#file-name').isVisible(), true);
  assert.deepEqual(JSON.parse(await page.locator('#output-text').textContent()), JSON.parse(source));
}

for (const directory of locales) {
  const catalog = JSON.parse(await readFile(join(root, '_locales', directory, 'messages.json'), 'utf8'));
  const message = (key) => catalog[key].message;
  const brand = message('extName');
  const locale = directory === 'en' ? 'en-US' : directory.replace('_', '-');
  await mkdir(join(assets, directory), { recursive: true });
  const promos = await writePromoSources(assets, directory, catalog);
  const profile = await mkdtemp(join(tmpdir(), 'json-toolbox-store-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      ...(executablePath ? { executablePath } : { channel: 'chromium' }),
      headless: true,
      locale,
      colorScheme: 'light',
      reducedMotion: 'reduce',
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      env: { ...process.env, LANG: locale.replace('-', '_') + '.UTF-8', LANGUAGE: locale.replace('-', '_') },
      args: [`--lang=${locale}`, `--disable-extensions-except=${root}`, `--load-extension=${root}`],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
    const extensionId = new URL(worker.url()).hostname;
    const base = `chrome-extension://${extensionId}`;
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));

    for (const { svg, png, width, height } of promos) {
      await page.setViewportSize({ width, height });
      await page.goto(pathToFileURL(join(assets, svg)).href);
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(() => [...document.querySelectorAll('text')].flatMap((element) => {
        const box = element.getBBox();
        const width = document.documentElement.viewBox.baseVal.width;
        const maxWidth = Number(element.dataset.maxWidth || width);
        const minX = Number(element.dataset.minX || 0);
        const maxX = Number(element.dataset.maxX || width);
        return box.x < minX - 1 || box.x + box.width > maxX + 1 || box.width > maxWidth + 1
          ? [{ text: element.textContent, x: box.x, width: box.width, maxWidth }] : [];
      }));
      assert.deepEqual(overflow, [], `${svg}: text must fit`);
      await capture(page, png, width, height);
    }
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.goto(base + '/formatter.html');
    await verifyCatalog(page, catalog, directory);
    assert.equal(await page.locator('.brand-name').textContent(), brand);
    await page.locator('#btn-sample').click();
    await waitForOutput(page);
    assert.equal(JSON.parse(await page.locator('#input').inputValue()).name, brand);
    await page.locator('#btn-clear').click();
    const formatterData = {
      project: brand,
      local: true,
      tools: [message('btnFormat'), message('btnMinify'), message('btnCompare')],
      import: { encoding: 'UTF-8', maxMiB: 50 },
      tracking: null,
    };
    await importJson(page, 'sample.json', JSON.stringify(formatterData, null, 2));
    await page.locator('#view-tree').click();
    await page.waitForSelector('#tree.virtual-tree');
    await page.locator('#level-select').selectOption('3');
    await page.locator('h1').click();
    await verifyPage(page, catalog);
    await capture(page, `${directory}/01-formatter-tree.png`, 1280, 800);

    await page.goto(base + '/compare.html');
    const left = {
      version: 1,
      users: [{ id: 1, name: 'Alex', role: 'admin' }, { id: 2, name: 'Sam', role: 'user' }],
      updatedAt: '2026-11-01',
    };
    const right = {
      version: 2,
      users: [{ id: 2, name: 'Sam', role: 'admin' }, { id: 3, name: 'Lee', role: 'user' }],
      updatedAt: '2026-11-03',
    };
    await page.locator('#input-left').fill(JSON.stringify(left, null, 2));
    await page.locator('#input-right').fill(JSON.stringify(right, null, 2));
    await page.locator('#input-left').press('Control+Home');
    await page.locator('#input-right').press('Control+Home');
    await page.locator('#array-mode').selectOption('key');
    await page.locator('#key-field').fill('id');
    await page.locator('#ignore-paths').fill('updatedAt');
    await page.locator('#btn-compare').click();
    await page.waitForFunction(() => !document.querySelector('#result').hidden && document.querySelector('#busy').hidden);
    await page.locator('h1').click();
    await verifyPage(page, catalog);
    await capture(page, `${directory}/02-compare-structure.png`, 1280, 800);
    await page.locator('#view-text').click();
    await page.waitForFunction(() => !document.querySelector('#text-view').hidden && document.querySelector('#text-view .tline'));
    await page.locator('h1').click();
    await verifyPage(page, catalog);
    await capture(page, `${directory}/03-compare-text.png`, 1280, 800);

    await page.goto(base + '/minify.html');
    const minifyData = { id: 42, active: true, items: [1, 2, 3] };
    await importJson(page, 'data.json', JSON.stringify(minifyData, null, 2));
    assert.equal(await page.locator('#output-text').textContent(), JSON.stringify(minifyData));
    await page.locator('h1').click();
    await verifyPage(page, catalog);
    await capture(page, `${directory}/04-minify-import.png`, 1280, 800);

    for (const action of ['minify', 'escape', 'unescape']) {
      await page.goto(base + `/${action}.html`);
      await page.locator('#btn-sample').click();
      await waitForOutput(page);
      const input = await page.locator('#input').inputValue();
      const sample = action === 'unescape' ? JSON.parse('"' + input + '"') : input;
      assert.equal(JSON.parse(sample).name, brand, `${locale}: ${action} sample brand`);
      await verifyPage(page, catalog);
    }
    assert.deepEqual(errors, [], `${locale}: browser errors`);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
  if (directory === 'en') {
    // Preserve the original English asset URLs as byte-identical aliases.
    for (const [source, target] of [
      ['promo-440x280.svg', 'promo.svg'],
      ['promo-1400x560.svg', 'promo-1400x560.svg'],
      ['promo-440x280.png', 'promo-440x280.png'],
      ['promo-1400x560.png', 'promo-1400x560.png'],
    ]) await copyFile(join(assets, 'en', source), join(assets, target));
  }
  console.log(`${directory}: generated 4 screenshots and 2 promotional images`);
}
console.log(JSON.stringify({ generated: output }, null, 2));
