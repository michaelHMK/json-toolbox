// Optional browser regression: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs
// CHROMIUM_EXECUTABLE=/path/to/chrome node bench/accessibility.mjs [repo]
// Local HTTP + a catalog-backed chrome.i18n stub; no extension installation or screen reader required.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const root = resolve(process.argv[2] || '.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
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
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
const results = [];
const errors = [];
const screenshotDir = process.env.ACCESSIBILITY_SCREENSHOT_DIR;
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });

try {
  for (const locale of ['en', 'ar']) {
    const catalog = JSON.parse(await readFile(resolve(root, `_locales/${locale}/messages.json`), 'utf8'));
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale });
    await context.addInitScript(({ locale, catalog }) => {
      globalThis.chrome = {
        ...globalThis.chrome,
        i18n: {
          getUILanguage: () => locale,
          getMessage(key, substitutions = []) {
            if (key === '@@bidi_dir') return locale === 'ar' ? 'rtl' : 'ltr';
            const entry = catalog[key];
            if (!entry) return '';
            const values = Array.isArray(substitutions) ? substitutions : [substitutions];
            return entry.message.replace(/\$([a-z_]+)\$/gi, (_, name) => {
              const content = entry.placeholders?.[name.toLowerCase()]?.content || '';
              return content.replace(/\$(\d+)/g, (_, index) => values[Number(index) - 1] || '');
            });
          },
        },
      };
    }, { locale, catalog });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`${locale}: ${error.message}`));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Accessibility.enable');
    const settled = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

    async function axNode(selector) {
      const { root: documentNode } = await cdp.send('DOM.getDocument');
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: documentNode.nodeId, selector });
      assert.ok(nodeId, `DOM node missing: ${selector}`);
      const { node } = await cdp.send('DOM.describeNode', { nodeId });
      const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
      const accessible = nodes.find((item) => item.backendDOMNodeId === node.backendNodeId);
      assert.ok(accessible && !accessible.ignored, `AX node missing: ${selector}`);
      return { ...accessible, properties: Object.fromEntries(accessible.properties.map((property) => [property.name, property.value])) };
    }

    async function activeTreeItem(selector = '#tree') {
      const item = await page.locator(selector).evaluate((tree) => {
        const id = tree.getAttribute('aria-activedescendant');
        const active = id && document.getElementById(id);
        return {
          id, path: active?.dataset.path, role: active?.getAttribute('role'),
          level: active?.getAttribute('aria-level'), position: active?.getAttribute('aria-posinset'),
          size: active?.getAttribute('aria-setsize'), expanded: active?.getAttribute('aria-expanded'),
          contained: !!active && tree.contains(active), focused: document.activeElement === tree,
          hidden: !!active?.closest('[hidden], [aria-hidden="true"]'),
        };
      });
      assert.ok(item.id && item.contained, 'Active descendant must stay mounted in its tree');
      assert.equal(item.role, 'treeitem');
      assert.equal(item.hidden, false);
      assert.equal(item.focused, true, 'DOM focus must remain on the tree');
      assert.ok(Number(item.level) >= 1);
      assert.ok(Number(item.position) >= 1 && Number(item.position) <= Number(item.size));
      return item;
    }

    for (const name of ['formatter', 'minify', 'escape', 'unescape', 'compare']) {
      await page.goto(`${base}/${name}.html`);
      await page.waitForFunction((expected) => document.documentElement.lang === expected, locale);
      const semantics = await page.evaluate(() => {
        const alert = document.querySelector('#error').closest('[role="alert"]');
        const busy = document.querySelector('#busy').closest('[role="status"]');
        const status = document.querySelector('#status');
        return {
          direction: document.documentElement.dir,
          code: [...document.querySelectorAll('textarea, pre, #tree, #tree-left, #tree-right, #key-field, #ignore-paths, #match-info, #diff-info')]
            .map((element) => ({ id: element.id, dir: element.dir, computed: getComputedStyle(element).direction })),
          names: [...document.querySelectorAll('[data-i18n-aria-label]')]
            .map((element) => ({ key: element.dataset.i18nAriaLabel, label: element.getAttribute('aria-label') })),
          alertReady: !!alert && !alert.closest('[hidden]') && alert.getAttribute('aria-atomic') === 'true',
          busyReady: !!busy && !busy.closest('[hidden]'),
          statusReady: status.getAttribute('role') === 'status' && !status.closest('[hidden]'),
        };
      });
      assert.equal(semantics.direction, locale === 'ar' ? 'rtl' : 'ltr');
      for (const code of semantics.code) {
        assert.equal(code.dir, 'ltr', `${name}/${code.id} explicit LTR`);
        assert.equal(code.computed, 'ltr', `${name}/${code.id} computed LTR`);
      }
      for (const name of semantics.names) assert.equal(name.label, catalog[name.key].message);
      assert.equal(semantics.alertReady, true);
      assert.equal(semantics.busyReady, true);
      assert.equal(semantics.statusReady, true);

      const run = name === 'formatter' ? '#btn-format' : name === 'compare' ? '#btn-compare' : '#btn-run';
      await page.locator(run).click();
      await page.locator('#error').waitFor({ state: 'visible' });
      const alert = await axNode('.error-announcement');
      assert.equal(alert.role.value, 'alert');
      assert.equal(alert.properties.live.value, 'assertive');
      assert.equal(alert.properties.atomic.value, true);
      await page.locator('#btn-sample').click();
      await page.waitForFunction(() => document.querySelector('#status').textContent.length > 0);
      await settled();
      assert.equal(await page.locator('#error').isHidden(), true);
      const status = await axNode('#status');
      assert.equal(status.role.value, 'status');
      assert.equal(status.properties.live.value, 'polite');

      if (name === 'compare') {
        const left = await page.locator('#input-left').boundingBox();
        const right = await page.locator('#input-right').boundingBox();
        assert.ok(left.x < right.x && Math.abs(left.y - right.y) < 1, `${locale}: old stays left on desktop`);
        const treeLeft = await page.locator('#tree-left').boundingBox();
        const treeRight = await page.locator('#tree-right').boundingBox();
        assert.ok(treeLeft.x < treeRight.x, `${locale}: old result stays left`);
        if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `compare-${locale}.png`), fullPage: true });
        await page.setViewportSize({ width: 600, height: 900 });
        await settled();
        const narrowLeft = await page.locator('#input-left').boundingBox();
        const narrowRight = await page.locator('#input-right').boundingBox();
        assert.ok(narrowLeft.y < narrowRight.y && Math.abs(narrowLeft.x - narrowRight.x) < 1, `${locale}: inputs stack on narrow screens`);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await settled();
        assert.ok((await page.locator('#input-left').boundingBox()).x < (await page.locator('#input-right').boundingBox()).x);
        await page.locator('#view-text').click();
        await page.waitForFunction(() => document.querySelector('#text-view').textContent.length > 0);
        assert.equal(await page.locator('#view-text').getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('#view-struct').getAttribute('aria-pressed'), 'false');
        assert.equal((await axNode('#text-view')).role.value, 'region');
        await page.locator('#view-struct').click();
        assert.equal(await page.locator('#view-text').getAttribute('aria-pressed'), 'false');
      } else {
        assert.equal((await axNode('#output-text')).role.value, 'region');
      }
      await page.locator('#btn-clear').click();
      if (name !== 'compare') assert.equal(await page.locator('#output-text').getAttribute('role'), 'region');
      else assert.equal(await page.locator('#status').evaluate((element) => !!element.closest('[hidden]')), false);
      results.push(`${locale}/${name}: direction, labels, live regions, outputs`);
    }

    await page.goto(`${base}/formatter.html`);
    await page.locator('#input').fill(JSON.stringify({ branch: { one: 1, two: 2 }, empty: {}, tail: Array(2000).fill('value') }));
    await page.locator('#view-tree').click();
    await page.waitForFunction(() => document.querySelector('#tree').getAttribute('role') === 'tree');
    assert.equal(await page.locator('#view-tree').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#view-text').getAttribute('aria-pressed'), 'false');
    await page.locator('#match-next').focus();
    await page.keyboard.press('Tab');
    assert.equal((await activeTreeItem()).path, '');

    async function key(key, path, expanded) {
      await page.keyboard.press(key);
      await settled();
      const item = await activeTreeItem();
      assert.equal(item.path, path, `${locale}: ${key} reaches ${path}`);
      if (expanded !== undefined) assert.equal(item.expanded, expanded);
    }
    await key('ArrowRight', '/branch', 'false');
    await key('ArrowRight', '/branch', 'true');
    await key('ArrowRight', '/branch/one', null);
    await key('ArrowDown', '/branch/two', null);
    await key('ArrowDown', '/empty', null);
    await key('ArrowRight', '/empty', null);
    await key('ArrowLeft', '', 'true');
    await key('ArrowRight', '/branch', 'true');
    await key('ArrowLeft', '/branch', 'false');
    await key('Enter', '/branch', 'true');
    await key('Space', '/branch', 'false');
    await key('End', '/tail', 'false');
    await key('ArrowRight', '/tail', 'true');
    await key('ArrowRight', '/tail/0', null);
    const leaf = page.locator('#tree .entry[data-path="/tail/0"] .v');
    await leaf.dblclick();
    assert.match(await page.evaluate(() => document.getSelection().toString()), /value/, 'Double-click keeps native word selection');
    const box = await leaf.boundingBox();
    await page.mouse.move(box.x + 9, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 9, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    assert.ok((await page.evaluate(() => document.getSelection().toString())).length > 0, 'Dragging keeps native text selection');
    await key('End', '/tail/1999', null);
    const last = await activeTreeItem();
    assert.equal(last.position, '2000');
    assert.equal(last.size, '2000');
    assert.equal(last.level, '3');
    const treeAX = await axNode('#tree');
    assert.equal(treeAX.role.value, 'tree');
    assert.equal(treeAX.name.value, catalog.paneResult.message);
    const itemAX = await axNode(`#${last.id}`);
    assert.equal(itemAX.role.value, 'treeitem');
    assert.equal(itemAX.properties.level.value, 3);
    assert.ok(treeAX.properties.activedescendant.relatedNodes.some((node) => node.backendDOMNodeId === itemAX.backendDOMNodeId));

    await page.locator('#tree').hover();
    await page.mouse.wheel(0, -100000);
    await page.waitForFunction(() => document.querySelector('#tree').scrollTop === 0);
    await settled();
    const pinned = await activeTreeItem();
    assert.equal(pinned.path, '/tail/1999');
    assert.equal((await axNode(`#${pinned.id}`)).role.value, 'treeitem');
    assert.ok(await page.locator('#tree .entry').count() < 100, 'Virtualization stays bounded');
    await key('ArrowUp', '/tail/1998');
    await key('Home', '');
    await key('ArrowLeft', '', 'false');
    await key('ArrowDown', '', 'false');
    await key('ArrowRight', '', 'true');
    const snapshot = await page.locator('#tree').ariaSnapshot();
    assert.match(snapshot, /treeitem/);
    assert.match(snapshot, /expanded/);
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `formatter-tree-${locale}.png`), fullPage: true });
    await page.keyboard.press('Tab');
    assert.notEqual(await page.evaluate(() => document.activeElement.id), 'tree', 'Tab exits the tree');
    results.push(`${locale}/tree: Tab, arrows, Home/End, expand/collapse, virtual focus, native selection, AX semantics`);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: browser.version(), results, screenshotDir: screenshotDir || null }, null, 2));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
