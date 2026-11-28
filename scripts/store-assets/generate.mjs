// Generate localized promotional images and screenshots of the real extension.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
// CHROMIUM_EXECUTABLE=/path/to/full/chromium node scripts/store-assets/generate.mjs
// Optional: STORE_LOCALES=en,zh_CN to regenerate selected locales only.
// Add --promos-only to update promotional images without recapturing screenshots.
// Extension loading requires full Chromium, not chrome-headless-shell.
import assert from 'node:assert/strict';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FONTS, writePromoSources } from './promos.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const assets = join(projectRoot, 'store-assets');
const root = join(projectRoot, 'src');
const executablePath = process.env.CHROMIUM_EXECUTABLE;
const available = (await readdir(join(root, '_locales'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
const locales = process.env.STORE_LOCALES
  ? [...new Set(process.env.STORE_LOCALES.split(',').map((locale) => locale.trim()))]
  : available;
assert(locales.length && locales.every((locale) => available.includes(locale)),
  `STORE_LOCALES must use catalog directories: ${available.join(', ')}`);
const captions = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), 'captions.json'), 'utf8'));
for (const locale of locales) {
  assert(
    captions[locale]?.autoFormat && captions[locale]?.compare && captions[locale]?.lenient
    && captions[locale]?.yaml && captions[locale]?.themes,
    `Missing screenshot captions for ${locale}`,
  );
}
const output = [];
const promosOnly = process.argv.includes('--promos-only');

const OBSOLETE_SCREENSHOTS = [
  '01-formatter-tree.png',
  '03-compare-text.png',
  '04-minify-import.png',
  '05-theme-picker.png',
];

const API_SAMPLE_JSON = [
  '{',
  '  "id": 9007199254740993,',
  '  "name": "json-toolbox",',
  '  "full_name": "michaelHMK/json-toolbox",',
  '  "private": false,',
  '  "description": "High-performance local JSON formatter, viewer, diff and YAML toolbox",',
  '  "owner": {',
  '    "login": "michaelHMK",',
  '    "type": "User"',
  '  },',
  '  "topics": ["json", "json-viewer", "json5", "yaml", "diff"],',
  '  "license": {',
  '    "key": "mit",',
  '    "name": "MIT License"',
  '  },',
  '  "capabilities": {',
  '    "maxFileMiB": 50,',
  '    "localOnly": true,',
  '    "themes": ["normal", "comfort", "dark"]',
  '  }',
  '}',
].join('\n');

const LENIENT_SAMPLE_JSONC = [
  '{',
  '  // JSONC & JSON5 comments + trailing commas',
  '  tabSize: 2,',
  '  "insertSpaces": true,',
  '  \'colorTheme\': \'Default Light\',',
  '  /* Block comment & hex literal */',
  '  "maxRetries": 0x10,',
  '  "files.associations": {',
  '    "*.jsonc": "jsonc",',
  '    "*.jsonl": "json",',
  '  },',
  '  "feedbackDays": +7,',
  '}',
].join('\n');

const K8S_YAML_INPUT_JSON = [
  '{',
  '  "apiVersion": "apps/v1",',
  '  "kind": "Deployment",',
  '  "metadata": {',
  '    "name": "json-toolbox-api",',
  '    "labels": { "app": "toolbox", "country": "NO" }',
  '  },',
  '  "spec": {',
  '    "replicas": 3,',
  '    "template": {',
  '      "spec": {',
  '        "containers": [{',
  '          "name": "gateway",',
  '          "image": "ghcr.io/example/gateway:1.7",',
  '          "ports": [{ "containerPort": 8080 }],',
  '          "env": [',
  '            {',
  '              "name": "BUILD_ID",',
  '              "value": 9007199254740993',
  '            },',
  '            { "name": "MAX_FILE_MIB", "value": 50 }',
  '          ]',
  '        }]',
  '      }',
  '    }',
  '  }',
  '}',
].join('\n');

function buildLargeDataset() {
  const targetBytes = 52_420_000;
  const header = '{"service":"json-toolbox-metrics","version":1,"precisionId":9007199254740993,"local":true,"summary":{"rows":520,"encoding":"UTF-8"},"chunks":[';
  const footer = ']}';
  const chunk = JSON.stringify({ region: 'ap-east-1', status: 'ok', payload: 'x'.repeat(100_000) });
  const count = Math.floor((targetBytes - header.length - footer.length - 128) / (chunk.length + 1));
  const prefix = header + Array(count).fill(chunk).join(',');
  const tailPadLen = targetBytes - prefix.length - footer.length - ',{"tail":""}'.length;
  const tail = tailPadLen > 0 ? `,{"tail":"${'x'.repeat(tailPadLen)}"}` : '';
  return Buffer.from(prefix + tail + footer, 'utf8');
}

const largeDatasetBuffer = promosOnly ? null : buildLargeDataset();

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

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

async function captureCaptioned(canvasPage, rawBuffer, name, { locale, caption, browserUrl = null }) {
  const rtl = locale === 'ar';
  const font = FONTS[locale] || 'Arial, "Noto Sans", sans-serif';
  const imgSrc = `data:image/png;base64,${rawBuffer.toString('base64')}`;
  const cardWidth = browserUrl ? 1040 : 1088;
  const chromeBar = browserUrl
    ? `<div class="chrome-bar" dir="ltr">
         <span class="dots"><i></i><i></i><i></i></span>
         <div class="url-pill"><span class="lock">https</span><span class="url-text">${escapeHtml(browserUrl.replace(/^https:\/\//, ''))}</span></div>
       </div>`
    : '';
  const html = `<!DOCTYPE html>
<html lang="${escapeHtml(locale.replace('_', '-'))}" dir="${rtl ? 'rtl' : 'ltr'}">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 1280px; height: 800px; overflow: hidden;
    font-family: ${font};
    background: linear-gradient(145deg, #635bff 0%, #3e37a6 100%);
    color: #fff;
    display: flex; flex-direction: column; align-items: center;
  }
  .caption-header {
    width: 100%; height: 80px; padding: 0 56px;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .caption-text {
    max-width: 1168px;
    font-size: 25px; font-weight: 700; line-height: 1.25;
    white-space: nowrap; text-align: center;
    letter-spacing: -0.01em;
  }
  .stage {
    flex: 1; width: 100%;
    display: flex; align-items: flex-start; justify-content: center;
    padding: 4px 24px 24px;
  }
  .card {
    width: ${cardWidth}px;
    border-radius: 12px;
    overflow: hidden;
    background: #ffffff;
    border: 1px solid rgba(255, 255, 255, 0.28);
    box-shadow: 0 22px 48px rgba(17, 13, 64, 0.42);
  }
  .chrome-bar {
    height: 34px; background: #eef1f7; border-bottom: 1px solid #d7dde8;
    display: flex; align-items: center; gap: 14px; padding: 0 14px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .dots { display: inline-flex; gap: 6px; }
  .dots i { width: 10px; height: 10px; border-radius: 50%; display: block; background: #cbd3e1; }
  .url-pill {
    flex: 1; height: 22px; border-radius: 11px; background: #ffffff;
    border: 1px solid #d5dbe6; padding: 0 10px;
    display: flex; align-items: center; gap: 6px;
    font-size: 12px; color: #1f2937; overflow: hidden; white-space: nowrap;
  }
  .lock { color: #167c5b; font-weight: 700; }
  .url-text { color: #1f2937; }
  .shot { width: 100%; height: auto; display: block; }
</style>
</head>
<body>
  <header class="caption-header"><div class="caption-text">${escapeHtml(caption)}</div></header>
  <main class="stage">
    <div class="card">${chromeBar}<img class="shot" src="${imgSrc}" alt=""></div>
  </main>
</body>
</html>`;
  await canvasPage.setViewportSize({ width: 1280, height: 800 });
  await canvasPage.setContent(html, { waitUntil: 'load' });
  await canvasPage.evaluate(() => document.fonts.ready);
  await canvasPage.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const overflow = await canvasPage.evaluate(() => {
    const captionEl = document.querySelector('.caption-text');
    const headerEl = document.querySelector('.caption-header');
    const cardEl = document.querySelector('.card');
    const issues = [];
    if (captionEl.scrollWidth > captionEl.clientWidth + 1) issues.push(`Caption width overflow: ${captionEl.scrollWidth} > ${captionEl.clientWidth}`);
    if (captionEl.getBoundingClientRect().bottom > headerEl.getBoundingClientRect().bottom + 1) issues.push('Caption bottom overflow');
    if (cardEl.getBoundingClientRect().bottom > window.innerHeight + 1) issues.push(`Card bottom overflow: ${cardEl.getBoundingClientRect().bottom}`);
    return issues;
  });
  assert.deepEqual(overflow, [], `${name}: caption layout must fit`);
  await capture(canvasPage, name, 1280, 800);
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
  assert.deepEqual(result.mismatches, [], `${locale}: native extension translations`);
  console.log(`${locale}: browser=${result.language}, UI=${result.uiLocale}, ${Object.keys(catalog).length} messages verified`);
}

async function verifyPage(target, catalog, label = null) {
  assert.equal(await target.locator('#error').isVisible(), false);
  const problems = await target.evaluate((catalog) => {
    const problems = [];
    for (const [attribute, property] of [
      ['data-i18n', 'textContent'], ['data-i18n-title', 'title'], ['data-i18n-placeholder', 'placeholder'],
      ['data-i18n-aria-label', 'aria-label'],
    ]) {
      for (const element of document.querySelectorAll(`[${attribute}]`)) {
        const key = element.getAttribute(attribute);
        const value = property === 'aria-label' ? element.getAttribute(property) : element[property];
        if (value !== catalog[key].message) problems.push(`${key}: incorrect ${property}`);
      }
    }
    if (document.documentElement.scrollWidth > window.innerWidth) problems.push('Horizontal page overflow');
    for (const element of document.querySelectorAll('button, .nav-link, .page-heading, .field')) {
      if (!element.checkVisibility()) continue;
      const rect = element.getBoundingClientRect();
      if (rect.left < -1 || rect.right > window.innerWidth + 1 || rect.top < -1 || rect.bottom > window.innerHeight + 1) {
        problems.push(`Control outside viewport: ${element.id || element.textContent.trim()}`);
      }
    }
    return problems;
  }, catalog);
  assert.deepEqual(problems, [], `Localized page: ${label || target.url()}`);
}

async function selectTheme(page, theme) {
  await page.locator('#theme-trigger').click();
  await page.locator(`[data-theme-option="${theme}"]`).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
  assert.equal(await page.locator('#theme-switch').isHidden(), true);
  assert.equal(await page.evaluate(() => localStorage.getItem('json-toolbox.theme')), theme);
}

async function waitForOutput(page) {
  await page.waitForFunction(() => document.querySelector('#busy').hidden && Boolean(document.querySelector('#output-text').textContent));
}

const tempRoot = await mkdtemp(join(tmpdir(), 'json-toolbox-store-ext-'));
const extCopy = join(tempRoot, 'ext');
await cp(root, extCopy, { recursive: true });
const manifestPath = join(extCopy, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions = ['http://*/*', 'https://*/*'];
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

try {
  for (const directory of locales) {
    const catalog = JSON.parse(await readFile(join(root, '_locales', directory, 'messages.json'), 'utf8'));
    const message = (key) => catalog[key].message;
    const brand = message('appName');
    const locale = directory === 'en' ? 'en-US' : directory.replace('_', '-');
    await mkdir(join(assets, directory), { recursive: true });
    if (!promosOnly) {
      for (const oldFile of OBSOLETE_SCREENSHOTS) {
        await rm(join(assets, directory, oldFile), { force: true });
      }
    }
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
        args: [`--lang=${locale}`, `--disable-extensions-except=${extCopy}`, `--load-extension=${extCopy}`],
      });
      const isBg = (w) => /^chrome-extension:\/\/[^/]+\/background\.js$/.test(w.url());
      const worker = context.serviceWorkers().find(isBg)
        || await context.waitForEvent('serviceworker', { predicate: isBg, timeout: 15000 });
      const extensionId = new URL(worker.url()).hostname;
      const base = `chrome-extension://${extensionId}`;
      const page = await context.newPage();
      const canvasPage = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      canvasPage.on('pageerror', (error) => errors.push(error.message));

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
      if (directory === 'en') {
        for (const [source, target] of [
          ['promo-440x280.svg', 'promo.svg'],
          ['promo-1400x560.svg', 'promo-1400x560.svg'],
          ['promo-440x280.png', 'promo-440x280.png'],
          ['promo-1400x560.png', 'promo-1400x560.png'],
        ]) await copyFile(join(assets, 'en', source), join(assets, target));
      }
      if (promosOnly) {
        assert.deepEqual(errors, [], `${locale}: browser errors`);
        console.log(`${directory}: generated 2 promotional images`);
        continue;
      }

      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(base + '/formatter.html');
      await verifyCatalog(page, catalog, directory);
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'normal');
      assert.equal(await page.locator('html').getAttribute('dir'), directory === 'ar' ? 'rtl' : 'ltr');
      assert.equal(await page.locator('.brand-name').textContent(), brand);

      // 1. Auto-format API JSON response page (normal theme)
      await worker.evaluate(() => syncAutoFormatScript());
      await context.route('https://api.github.com/repos/michaelHMK/json-toolbox', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json; charset=utf-8',
          body: API_SAMPLE_JSON,
        });
      });
      await page.goto('https://api.github.com/repos/michaelHMK/json-toolbox');
      await page.waitForSelector('#json-toolbox-viewer-host');
      await page.waitForFunction(() => {
        const host = document.querySelector('#json-toolbox-viewer-host');
        return host && getComputedStyle(host).visibility === 'visible';
      });
      const viewerFrame = page.frames().find((f) => f.url().includes('/viewer.html'));
      assert.ok(viewerFrame, `${directory}: viewer.html iframe must be mounted`);
      await viewerFrame.waitForSelector('#tree .entry');
      await verifyPage(viewerFrame, catalog, `${directory}/viewer`);
      await page.mouse.move(0, 0);
      const rawShot1 = await page.screenshot({ animations: 'disabled', caret: 'hide' });
      await captureCaptioned(canvasPage, rawShot1, `${directory}/01-auto-format-api.png`, {
        locale: directory,
        caption: captions[directory].autoFormat,
        browserUrl: 'https://api.github.com/repos/michaelHMK/json-toolbox',
      });

      // 2. Structural JSON diff with ignored paths + array key match (normal theme)
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
      await page.mouse.move(0, 0);
      const rawShot2 = await page.screenshot({ animations: 'disabled', caret: 'hide' });
      await captureCaptioned(canvasPage, rawShot2, `${directory}/02-compare-structure.png`, {
        locale: directory,
        caption: captions[directory].compare,
      });

      // 3. Lenient JSONC / JSON5 formatting with status notice (comfort theme)
      await page.goto(base + '/formatter.html');
      await selectTheme(page, 'comfort');
      if (await page.locator('#view-text').getAttribute('aria-pressed') !== 'true') {
        await page.locator('#view-text').click();
      }
      await page.locator('#input').fill(LENIENT_SAMPLE_JSONC);
      await page.locator('#input').press('Control+Home');
      await page.locator('#btn-format').click();
      await waitForOutput(page);
      assert.ok((await page.locator('#status').textContent()).includes(message('statusLenientParsed')),
        `${directory}: lenient status notice missing`);
      await page.locator('h1').click();
      await verifyPage(page, catalog);
      await page.mouse.move(0, 0);
      const rawShot3 = await page.screenshot({ animations: 'disabled', caret: 'hide' });
      await captureCaptioned(canvasPage, rawShot3, `${directory}/03-lenient-json.png`, {
        locale: directory,
        caption: captions[directory].lenient,
      });

      // 4. JSON -> YAML conversion with precision preservation (dark theme)
      await page.goto(base + '/yaml.html');
      await selectTheme(page, 'dark');
      await page.locator('#input').fill(K8S_YAML_INPUT_JSON);
      await page.locator('#input').press('Control+Home');
      await page.locator('#btn-run').click();
      await waitForOutput(page);
      assert.ok((await page.locator('#output-text').textContent()).includes('9007199254740993'),
        `${directory}: YAML output should preserve integer precision`);
      await page.locator('h1').click();
      await verifyPage(page, catalog);
      await page.mouse.move(0, 0);
      const rawShot4 = await page.screenshot({ animations: 'disabled', caret: 'hide' });
      await captureCaptioned(canvasPage, rawShot4, `${directory}/04-json-yaml.png`, {
        locale: directory,
        caption: captions[directory].yaml,
      });

      // 5. 50 MiB large dataset + virtual tree + 3-theme switcher (normal theme)
      await page.goto(base + '/formatter.html');
      await selectTheme(page, 'normal');
      const chooserPromise = page.waitForEvent('filechooser');
      await page.locator('#btn-import').click();
      const chooser = await chooserPromise;
      await chooser.setFiles({ name: 'dataset.json', mimeType: 'application/json', buffer: largeDatasetBuffer });
      await waitForOutput(page);
      assert.equal(await page.locator('#file-name').isVisible(), true);
      assert.match(await page.locator('#file-name').textContent(), /^dataset\.json · 50 MiB$/);
      await page.locator('#view-tree').click();
      await page.waitForSelector('#tree.virtual-tree .entry');
      await page.locator('#level-select').selectOption('2');
      await page.locator('#theme-trigger').click();
      assert.equal(await page.locator('#theme-switch').isVisible(), true);
      assert.equal(await page.locator('#theme-switch .theme-preview').count(), 3);
      await verifyPage(page, catalog);
      await page.mouse.move(0, 0);
      const rawShot5 = await page.screenshot({ animations: 'disabled', caret: 'hide' });
      await captureCaptioned(canvasPage, rawShot5, `${directory}/05-large-file-themes.png`, {
        locale: directory,
        caption: captions[directory].themes,
      });
      await page.keyboard.press('Escape');

      // Verify remaining tool samples cleanly across locales
      for (const action of ['minify', 'escape', 'unescape', 'yaml', 'json-from-yaml']) {
        await page.goto(base + `/${action}.html`);
        await page.locator('#btn-sample').click();
        await waitForOutput(page);
        if (action === 'json-from-yaml') {
          const parsed = JSON.parse(await page.locator('#output-text').textContent());
          assert.equal(parsed.metadata.name, brand, `${locale}: json-from-yaml sample brand`);
        } else {
          const input = await page.locator('#input').inputValue();
          const sample = action === 'unescape' ? JSON.parse('"' + input + '"') : input;
          assert.equal(JSON.parse(sample).name, brand, `${locale}: ${action} sample brand`);
        }
        await verifyPage(page, catalog);
      }
      assert.deepEqual(errors, [], `${locale}: browser errors`);
    } finally {
      await context?.close();
      await rm(profile, { recursive: true, force: true });
    }
    console.log(`${directory}: generated 5 captioned screenshots and 2 promotional images`);
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
console.log(JSON.stringify({ generated: output }, null, 2));
