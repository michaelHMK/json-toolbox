import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Element } from './helpers/page-dom.js';

const source = readFileSync(new URL('../src/content/detect.js', import.meta.url), 'utf8');

function setupDetect({ contentType = 'application/json', bodyNodes = [], readyState = 'complete', onMessage } = {}) {
  const body = new Element('BODY');
  for (const node of bodyNodes) body.appendChild(node);
  const rootEl = new Element('HTML');
  rootEl.appendChild(body);
  const posted = [];
  const doc = {
    contentType,
    readyState,
    body,
    documentElement: rootEl,
    createElement: (tag) => {
      const el = new Element(tag);
      if (tag.toLowerCase() === 'div') {
        el.attachShadow = () => {
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
    MessageChannel: FakeMessageChannel,
    chrome: {
      runtime: {
        getURL: (p) => `chrome-extension://ext/${p}`,
        onMessage: { addListener: onMessage || (() => {}) },
      },
      i18n: { getMessage: (k) => k },
    },
    setTimeout,
    clearTimeout,
  });
  context.window = { top: null };
  context.window.top = context.window;
  vm.runInContext(source, context);
  return { api: context.__jsonToolboxDetect, doc, rootEl, posted };
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
  const host = plainEnabled.doc.getElementById('json-toolbox-viewer-host');
  assert.ok(host);
  const iframe = host.shadowRoot.children[0];
  assert.equal(iframe.tagName.toLowerCase(), 'iframe');
  // Simulate iframe load & cancel timers cleanly via PARSE_ERROR or READY.
  iframe.events.load();
  assert.equal(plainEnabled.posted.length, 1);
  assert.ok(plainEnabled.posted[0].msg.buffer instanceof ArrayBuffer);
  // Confirm cleanup removes host if viewer reports PARSE_ERROR.
  plainEnabled.posted[0].transfer[0].postMessage({ type: 'PARSE_ERROR' });
  assert.equal(plainEnabled.doc.getElementById('json-toolbox-viewer-host'), null);
});
