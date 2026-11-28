import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Element } from './helpers/page-dom.js';

const source = readFileSync(new URL('../src/content/detect.js', import.meta.url), 'utf8');

function setupDetect({
  contentType = 'application/json',
  bodyNodes = [],
  readyState = 'complete',
  jsonParse,
  timerQueue = null,
} = {}) {
  const body = new Element('BODY');
  for (const node of bodyNodes) body.appendChild(node);
  const rootEl = new Element('HTML');
  rootEl.appendChild(body);
  const posted = [];
  const shadowModes = [];
  let messageListener = null;
  const scheduled = [];
  const nextSetTimeout = timerQueue
    ? (fn, ms) => {
        const entry = { fn, ms, cleared: false };
        timerQueue.push(entry);
        return entry;
      }
    : (fn, ms) => {
        const id = setTimeout(fn, ms);
        scheduled.push(id);
        return id;
      };
  const nextClearTimeout = timerQueue
    ? (entry) => { if (entry) entry.cleared = true; }
    : clearTimeout;
  const doc = {
    contentType,
    readyState,
    body,
    documentElement: rootEl,
    createElement: (tag) => {
      const el = new Element(tag);
      if (tag.toLowerCase() === 'div') {
        el.attachShadow = (opts) => {
          shadowModes.push(opts?.mode);
          const shadow = new Element('#shadow');
          el.shadowRoot = shadow;
          return shadow;
        };
      }
      if (tag.toLowerCase() === 'iframe') {
        el.contentWindow = {
          postMessage(msg, origin, transfer) {
            posted.push({ msg, origin, transfer });
          },
        };
      }
      return el;
    },
    getElementById: (id) => {
      const visit = (node) => {
        if (node.id === id) return node;
        for (const child of (node.children || [])) {
          const found = visit(child);
          if (found) return found;
        }
        return null;
      };
      return visit(rootEl);
    },
    addEventListener() {},
  };

  class FakePort {
    constructor() { this.onmessage = null; this._peer = null; }
    postMessage(data) { this._peer?.onmessage?.({ data }); }
  }
  class FakeMessageChannel {
    constructor() {
      this.port1 = new FakePort();
      this.port2 = new FakePort();
      this.port1._peer = this.port2;
      this.port2._peer = this.port1;
    }
  }

  const context = vm.createContext({
    __JSON_TOOLBOX_DETECT_TEST__: true,
    window: null,
    document: doc,
    location: { href: 'https://api.example.com/data.json' },
    TextEncoder,
    URL,
    JSON: { parse: jsonParse || JSON.parse },
    MessageChannel: FakeMessageChannel,
    chrome: {
      runtime: {
        id: 'ext',
        getURL: (p) => `chrome-extension://dynamic-guid/${p}`,
        onMessage: { addListener: (fn) => { messageListener = fn; } },
        sendMessage: () => {},
      },
      i18n: { getMessage: (k) => k },
    },
    setTimeout: nextSetTimeout,
    clearTimeout: nextClearTimeout,
  });
  context.window = { top: null };
  context.window.top = context.window;
  vm.runInContext(source, context);
  return {
    api: context.__jsonToolboxDetect,
    doc,
    rootEl,
    posted,
    shadowModes,
    triggerMessage: (msg, cb) => messageListener?.(msg, {}, cb || (() => {})),
    cleanupTimers: () => scheduled.forEach((id) => clearTimeout(id)),
  };
}

test('content type matching accepts JSON media types and gates text/plain', () => {
  const { api } = setupDetect();
  const cases = [
    ['application/json', false, true],
    ['application/json; charset=utf-8', false, true],
    ['text/json', false, true],
    ['application/problem+json', false, true],
    ['application/ld+json', false, true],
    ['text/plain', false, false],
    ['text/plain; charset=utf-8', true, true],
    ['text/html', true, false],
    ['application/xml', true, false],
    ['', true, false],
  ];
  for (const [ct, allowPlain, expected] of cases) {
    assert.equal(api.isJsonContentType(ct, allowPlain), expected, `${ct} (plain=${allowPlain})`);
  }
});

test('DOM detection accepts single <pre> with optional Chrome json-formatter-container and rejects mixed HTML', () => {
  const { api } = setupDetect();
  const pre = new Element('PRE');
  pre.textContent = '{"a":1}';
  const chromePrettyContainer = new Element('DIV');
  chromePrettyContainer.classList.add('json-formatter-container');

  assert.equal(api.findJsonPreElement({ body: { childNodes: [pre] } }), pre);
  assert.equal(
    api.findJsonPreElement({ body: { childNodes: [pre, chromePrettyContainer, { nodeType: 3, nodeValue: '  \n' }] } }),
    pre,
  );
  assert.equal(api.findJsonPreElement({ body: { childNodes: [pre, new Element('PRE')] } }), null);
  assert.equal(api.findJsonPreElement({ body: { childNodes: [pre, new Element('DIV')] } }), null);
  assert.equal(
    api.findJsonPreElement({ body: { childNodes: [pre, { nodeType: 3, nodeValue: 'stray text' }] } }),
    null,
  );
});

test('detectAndMount rejects invalid JSON, non-container text/plain, and leaves original page untouched', () => {
  const invalidPre = new Element('PRE');
  invalidPre.textContent = '{bad json}';
  const invalidPage = setupDetect({ contentType: 'application/json', bodyNodes: [invalidPre] });
  assert.deepEqual(structuredClone(invalidPage.api.detectAndMount({ allowPlainText: false })), { ok: false, reason: 'not-json' });
  assert.equal(invalidPage.rootEl.querySelectorAll('div').length, 0);

  const plainTextPre = new Element('PRE');
  plainTextPre.textContent = '12345';
  const plainDisabled = setupDetect({ contentType: 'text/plain', bodyNodes: [plainTextPre] });
  assert.deepEqual(structuredClone(plainDisabled.api.detectAndMount({ allowPlainText: false })), { ok: false, reason: 'not-json' });

  const plainNonContainer = setupDetect({ contentType: 'text/plain', bodyNodes: [plainTextPre] });
  assert.deepEqual(structuredClone(plainNonContainer.api.detectAndMount({ allowPlainText: true })), { ok: false, reason: 'not-json' });

  const plainObjPre = new Element('PRE');
  plainObjPre.textContent = '  {"valid":true}';
  const plainEnabled = setupDetect({ contentType: 'text/plain', bodyNodes: [plainObjPre] });
  const mounted = plainEnabled.api.detectAndMount({ allowPlainText: true });
  assert.equal(mounted.ok, true);
  assert.deepEqual(plainEnabled.shadowModes, ['closed']);
  const host = plainEnabled.doc.getElementById('json-toolbox-viewer-host');
  assert.ok(host);
  const iframe = host.shadowRoot.children[0];
  assert.equal(iframe.tagName.toLowerCase(), 'iframe');
  // Simulate iframe load & cancel timers cleanly via PARSE_ERROR or READY.
  iframe.events.load();
  assert.equal(plainEnabled.posted.length, 1);
  assert.equal(plainEnabled.posted[0].origin, 'chrome-extension://ext');
  assert.ok(plainEnabled.posted[0].msg.buffer instanceof ArrayBuffer);
  // Confirm cleanup removes host if viewer reports PARSE_ERROR.
  plainEnabled.posted[0].transfer[0].postMessage({ type: 'PARSE_ERROR' });
  assert.equal(plainEnabled.doc.getElementById('json-toolbox-viewer-host'), null);
});

test('handles on-demand large parse errors with toast, READY timeout recovery, and non-blocking COEP fallback', () => {
  const largeBad = new Element('PRE');
  largeBad.textContent = '{' + ' '.repeat(260 * 1024) + 'bad';
  const onDemandTimers = [];
  const onDemandPage = setupDetect({
    contentType: 'application/json',
    bodyNodes: [largeBad],
    timerQueue: onDemandTimers,
  });
  // Production installs listener when __JSON_TOOLBOX_DETECT_TEST__ is false; exercise onDemand option directly here.
  const firstMount = onDemandPage.api.detectAndMount({ allowPlainText: true, onDemand: true });
  assert.equal(firstMount.ok, true);
  const host = onDemandPage.doc.getElementById('json-toolbox-viewer-host');
  const iframe = host.shadowRoot.children[0];
  iframe.events.load();
  onDemandPage.posted[0].transfer[0].postMessage({ type: 'PARSE_ERROR' });
  assert.equal(onDemandPage.doc.getElementById('json-toolbox-viewer-host'), null);
  const toastHost = onDemandPage.doc.getElementById('json-toolbox-toast-host');
  assert.ok(toastHost);
  assert.equal(toastHost.shadowRoot.children[0].textContent, 'errPageNotJson');

  // Verify ACK starts a READY timer whose expiry tears down and enables COEP fallback without main-thread JSON.parse.
  const largeValid = new Element('PRE');
  largeValid.textContent = '{"ok":' + '1,'.repeat(140 * 1024) + '2}';
  const timers = [];
  const timeoutPage = setupDetect({
    contentType: 'application/json',
    bodyNodes: [largeValid],
    timerQueue: timers,
    jsonParse() {
      throw new Error('JSON.parse must not run on main thread for >256 KiB fallback');
    },
  });
  timeoutPage.api.detectAndMount({ allowPlainText: false });
  const h2 = timeoutPage.doc.getElementById('json-toolbox-viewer-host');
  h2.shadowRoot.children[0].events.load();
  timeoutPage.posted[0].transfer[0].postMessage({ type: 'ACK' });
  const readyTimer = timers.at(-1);
  assert.equal(readyTimer.ms, 30000);
  assert.equal(readyTimer.cleared, false);
  readyTimer.fn();
  const fallbackHost = timeoutPage.doc.getElementById('json-toolbox-viewer-host');
  assert.ok(fallbackHost);
  assert.equal(fallbackHost.dataset.fallback, 'true');
});
