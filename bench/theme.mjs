// Optional browser check: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node bench/theme.mjs [repo]
// CHROMIUM_EXECUTABLE overrides the browser; THEME_SCREENSHOT_DIR optionally saves real UI screenshots.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const root = resolve(process.argv[2] || '.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const storageKey = 'json-toolbox.theme';
const pages = ['formatter', 'minify', 'escape', 'unescape', 'compare'];
const modes = ['normal', 'comfort', 'dark'];
const colors = {
  normal: ['rgb(245, 247, 251)', 'rgb(255, 255, 255)', 'light'],
  comfort: ['rgb(233, 235, 237)', 'rgb(242, 243, 242)', 'light'],
  dark: ['rgb(18, 21, 27)', 'rgb(26, 30, 38)', 'dark'],
};
const server = createServer(async (request, response) => {
  try {
    const file = resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
    if (!file.startsWith(root + '/')) throw new Error('Invalid path');
    const data = await readFile(file);
    response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' })[extname(file)] || 'application/octet-stream');
    response.end(data);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
const errors = [];
const results = [];
const watch = page => page.on('pageerror', error => errors.push(error.message));
const useLocale = async (context, locale) => {
  const catalog = JSON.parse(await readFile(resolve(root, '_locales', locale, 'messages.json'), 'utf8'));
  await context.addInitScript(({ catalog, locale }) => {
    window.chrome = { i18n: {
      getUILanguage: () => locale.replace('_', '-'),
      getMessage: (key, substitutions) => {
        if (key === '@@bidi_dir') return locale === 'ar' ? 'rtl' : 'ltr';
        const entry = catalog[key];
        let value = entry?.message || '';
        for (const [name, placeholder] of Object.entries(entry?.placeholders || {})) {
          value = value.replaceAll(new RegExp(`\\$${name}\\$`, 'gi'), placeholder.content);
        }
        const values = Array.isArray(substitutions) ? substitutions : [substitutions];
        values.forEach((substitution, index) => { value = value.replaceAll(`$${index + 1}`, substitution ?? ''); });
        return value;
      },
    } };
  }, { catalog, locale });
  return catalog;
};
const open = async (context, name = 'formatter') => {
  const page = await context.newPage();
  watch(page);
  await page.goto(`${base}/${name}.html`);
  return page;
};
const theme = async (page, expected) => {
  await page.waitForFunction(value => document.documentElement.dataset.theme === value, expected);
  assert.equal(await page.locator('#theme-switch button').count(), 3);
  assert.deepEqual(await page.locator('#theme-switch [aria-pressed="true"]').evaluateAll(buttons => buttons.map(button => button.dataset.themeOption)), [expected]);
  const actual = await page.evaluate(() => [
    getComputedStyle(document.body).backgroundColor,
    getComputedStyle(document.querySelector('.pane')).backgroundColor,
    getComputedStyle(document.documentElement).colorScheme,
  ]);
  assert.deepEqual(actual, colors[expected]);
};
const select = async (page, mode) => {
  await page.locator(`[data-theme-option="${mode}"]`).click();
  await theme(page, mode);
};
const format = async page => {
  const source = '{"themeTest":true,"values":[1,"two",null]}';
  await page.locator('#input').fill(source);
  await page.locator('#btn-format').click();
  await page.waitForFunction(() => document.querySelector('#output-text').textContent.includes('"themeTest": true'));
  return { source, result: await page.locator('#output-text').textContent() };
};

try {
  const context = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1280, height: 800 } });
  const page = await open(context);
  for (const name of pages) {
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${base}/${name}.html`);
    await theme(page, 'normal');
    for (const mode of modes) {
      await select(page, mode);
      assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), mode);
      await page.reload();
      await theme(page, mode);
      const reopened = await open(context, name);
      await theme(reopened, mode);
      await reopened.close();
    }
  }
  results.push('Five pages: normal default under a dark OS, three modes, reload/reopen persistence and CSS colors');

  await page.goto(`${base}/formatter.html`);
  await select(page, 'comfort');
  for (const name of pages) {
    await page.goto(`${base}/${name}.html`);
    await theme(page, 'comfort');
  }
  const peer = await open(context);
  await select(page, 'dark');
  await theme(peer, 'dark');
  await page.evaluate(key => localStorage.removeItem(key), storageKey);
  await theme(peer, 'normal');
  await select(page, 'comfort');
  await theme(peer, 'comfort');
  await page.evaluate(() => localStorage.clear());
  await theme(peer, 'normal');
  await page.evaluate(key => localStorage.setItem(key, 'unsupported'), storageKey);
  await theme(peer, 'normal');
  await page.reload();
  await theme(page, 'normal');
  await peer.close();
  results.push('Saved mode across tools; cross-tab changes, deletion, clear and invalid values');

  await page.goto(`${base}/formatter.html`);
  const formatted = await format(page);
  for (const mode of modes) {
    await select(page, mode);
    assert.equal(await page.locator('#input').inputValue(), formatted.source);
    assert.equal(await page.locator('#output-text').textContent(), formatted.result);
  }
  await page.goto(`${base}/compare.html`);
  const left = '{"amount":1,"items":["a"]}';
  const right = '{"amount":2,"items":["a"],"added":true}';
  await page.locator('#input-left').fill(left);
  await page.locator('#input-right').fill(right);
  await page.locator('#btn-compare').click();
  await page.waitForFunction(() => !document.querySelector('#result').hidden && document.querySelector('#tree-right .diff-added'));
  const comparison = await page.locator('#struct-view').textContent();
  for (const mode of modes) {
    await select(page, mode);
    assert.equal(await page.locator('#input-left').inputValue(), left);
    assert.equal(await page.locator('#input-right').inputValue(), right);
    assert.equal(await page.locator('#struct-view').textContent(), comparison);
  }
  results.push('Formatting and comparison work; switching themes preserves input and results');

  for (const failure of ['getter', 'read', 'write']) {
    const restricted = await browser.newContext();
    await restricted.addInitScript(failure => {
      if (failure === 'getter') Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } });
      else Storage.prototype[failure === 'read' ? 'getItem' : 'setItem'] = () => { throw new DOMException('Blocked', 'SecurityError'); };
    }, failure);
    const restrictedPage = await open(restricted);
    await theme(restrictedPage, 'normal');
    const saved = await format(restrictedPage);
    for (const mode of modes) {
      await select(restrictedPage, mode);
      assert.equal(await restrictedPage.locator('#input').inputValue(), saved.source);
      assert.equal(await restrictedPage.locator('#output-text').textContent(), saved.result);
    }
    await restricted.close();
  }
  results.push('localStorage getter/getItem/setItem failures preserve usable tools and theme switching');

  const locales = (await readdir(resolve(root, '_locales'))).sort();
  for (const locale of locales) {
    const localized = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const catalog = await useLocale(localized, locale);
    const localizedPage = await open(localized);
    assert.deepEqual(await localizedPage.locator('#theme-switch button').allTextContents(), ['themeNormal', 'themeComfort', 'themeDark'].map(key => catalog[key].message));
    for (const width of [1280, 1024, 736, 320]) {
      await localizedPage.setViewportSize({ width, height: 800 });
      await localizedPage.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      const layout = await localizedPage.locator('#theme-switch').evaluate(switcher => {
        const box = switcher.getBoundingClientRect();
        return {
          visible: box.width > 0 && box.height > 0 && box.top >= 0 && box.bottom <= innerHeight,
          withinViewport: box.left >= 0 && box.right <= innerWidth,
          buttons: [...switcher.querySelectorAll('button')].map(button => ({
            fits: button.scrollWidth <= button.clientWidth && button.scrollHeight <= button.clientHeight,
            visible: button.getBoundingClientRect().width > 0 && button.getBoundingClientRect().height > 0,
          })),
        };
      });
      assert.ok(layout.visible && layout.withinViewport && layout.buttons.every(button => button.fits && button.visible), `${locale}/${width}: ${JSON.stringify(layout)}`);
      await select(localizedPage, 'comfort');
    }
    await localized.close();
  }
  results.push(`${locales.length} locales at 1280/1024/736/320px: theme labels translated, visible and contained`);

  if (process.env.THEME_SCREENSHOT_DIR) {
    const directory = resolve(process.env.THEME_SCREENSHOT_DIR);
    await mkdir(directory, { recursive: true });
    const screenshots = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await useLocale(screenshots, 'zh_CN');
    const screenshotPage = await open(screenshots);
    await screenshotPage.locator('#input').fill(JSON.stringify({ project: 'JSON 工具箱', local: true, tools: ['格式化', '压缩', '对比'], import: { encoding: 'UTF-8', maxMiB: 50 }, tracking: null }, null, 2));
    await screenshotPage.locator('#btn-format').click();
    await screenshotPage.locator('#view-tree').click();
    await screenshotPage.waitForFunction(() => document.querySelector('#tree .entry'));
    await screenshotPage.locator('#level-select').selectOption('3');
    for (const mode of modes) {
      await select(screenshotPage, mode);
      await screenshotPage.mouse.move(0, 0);
      await screenshotPage.screenshot({ path: resolve(directory, `implemented-theme-${mode}.png`), fullPage: true, animations: 'disabled' });
    }
    await screenshots.close();
    results.push(`Screenshots saved to ${directory}`);
  }
  await context.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: browser.version(), results }, null, 2));
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
}
