'use strict';

/*
 * Content script for auto-formatting JSON responses (and on-demand formatting).
 * Spike findings (Chromium 156):
 * - Chrome wraps its Pretty-print checkbox in <div class="json-formatter-container">
 *   beside a single <pre>.
 * - Embedding chrome-extension://<dynamic>/viewer.html via use_dynamic_url +
 *   frame-ancestors http: https: file: succeeds even on CSP default-src 'none' pages.
 * - Cross-Origin-Embedder-Policy: require-corp blocks the iframe handshake; detect.js
 *   restores the raw <pre> and shows a fallback bar with "Open in JSON Toolbox".
 */
(() => {
  if (typeof window !== 'undefined' && window !== window.top) return;

  const SMALL_PARSE_LIMIT = 256 * 1024;
  const HOST_ID = 'json-toolbox-viewer-host';
  const STORAGE_PLAIN_TEXT_KEY = 'formatPlainText';

  function normalizeMime(contentType) {
    return String(contentType || '').split(';')[0].trim().toLowerCase();
  }

  function isJsonContentType(contentType, allowPlainText) {
    const mime = normalizeMime(contentType);
    if (mime === 'application/json' || mime === 'text/json' || mime.endsWith('+json')) {
      return true;
    }
    return Boolean(allowPlainText && mime === 'text/plain');
  }

  function findJsonPreElement(doc) {
    const body = doc?.body;
    if (!body) return null;
    let pre = null;
    const nodes = body.childNodes?.length ? body.childNodes : (body.children || []);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.nodeType === 3) {
        if (/\S/.test(node.nodeValue || node.textContent || '')) return null;
        continue;
      }
      if (node.nodeType !== undefined && node.nodeType !== 1) continue;
      const tag = String(node.tagName || '').toUpperCase();
      if (tag === 'PRE') {
        if (pre) return null;
        pre = node;
      } else if (tag === 'DIV' && node.classList?.contains?.('json-formatter-container')) {
        continue;
      } else {
        return null;
      }
    }
    return pre;
  }

  function looksLikeJsonContainer(text) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) continue;
      return c === 123 || c === 91;
    }
    return false;
  }

  function hasNonWhitespace(text) {
    return /\S/.test(text);
  }

  function i18n(key, fallback) {
    try {
      return chrome.i18n?.getMessage?.(key) || fallback;
    } catch {
      return fallback;
    }
  }

  function showToast(message) {
    const existing = document.getElementById('json-toolbox-toast-host');
    existing?.remove();
    const host = document.createElement('div');
    host.id = 'json-toolbox-toast-host';
    host.style.cssText = 'position:fixed;top:14px;right:14px;z-index:2147483647;all:initial;';
    host.style.position = 'fixed';
    host.style.top = '14px';
    host.style.right = '14px';
    host.style.zIndex = '2147483647';
    const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    const box = document.createElement('div');
    box.setAttribute('role', 'status');
    box.style.cssText = 'font:13px/1.4 system-ui,-apple-system,sans-serif;background:#1e293b;color:#f8fafc;padding:9px 14px;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.22);';
    box.textContent = message;
    root.appendChild(box);
    (document.documentElement || document.body).appendChild(host);
    setTimeout(() => host.remove(), 3000);
  }

  function showFallbackBanner(rawText) {
    document.getElementById(HOST_ID)?.remove();
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;right:0;z-index:2147483647;';
    const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 14px;background:#f8fafc;color:#1e293b;border-bottom:1px solid #cbd5e1;font:13px/1.4 system-ui,-apple-system,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.08);';
    const note = document.createElement('span');
    note.textContent = i18n('viewerFallbackNotice', 'This page blocked embedded formatting.');
    note.style.flex = '1';
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.textContent = i18n('btnOpenToolbox', 'Open in JSON Toolbox');
    openBtn.style.cssText = 'padding:5px 12px;border:0;border-radius:6px;background:#635bff;color:#fff;font:600 12px/1.3 inherit;cursor:pointer;';
    openBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_IN_FORMATTER', text: rawText }, (response) => {
        if (response && !response.ok && response.reason === 'tooLarge') {
          showToast(i18n('errSelectionTooLarge', 'Selected text exceeds the 10 MB transfer limit. Copy and paste or import a file instead.'));
        }
      });
    });
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.style.cssText = 'padding:2px 8px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#475569;font:14px/1.2 inherit;cursor:pointer;';
    closeBtn.addEventListener('click', () => host.remove());
    bar.append(note, openBtn, closeBtn);
    root.appendChild(bar);
    (document.documentElement || document.body).appendChild(host);
  }

  function hideNativeJsonElements(pre) {
    const hidden = [];
    const targets = [pre];
    const container = document.body?.querySelector?.('.json-formatter-container');
    if (container) targets.push(container);
    for (const el of targets) {
      hidden.push([el, el.style.display]);
      el.style.setProperty('display', 'none', 'important');
    }
    return () => {
      for (const [el, prev] of hidden) {
        if (prev) el.style.display = prev;
        else el.style.removeProperty('display');
      }
    };
  }

  let mountState = 'idle'; // 'idle' | 'pending' | 'formatted'

  function mountViewer(pre, rawText, mime) {
    mountState = 'pending';
    document.getElementById(HOST_ID)?.remove();

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483647;visibility:hidden;pointer-events:none;';
    const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL(`viewer.html?url=${encodeURIComponent(location.href)}`);
    iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;';
    root.appendChild(iframe);

    const encoded = new TextEncoder().encode(rawText);
    const channel = new MessageChannel();
    let settled = false;
    let acked = false;
    let restoreNative = null;

    const loadTimeoutMs = rawText.length > SMALL_PARSE_LIMIT ? 15000 : 1500;
    let ackTimer = null;

    const cleanupFailure = (showFallback) => {
      if (settled) return;
      settled = true;
      clearTimeout(loadTimer);
      clearTimeout(ackTimer);
      restoreNative?.();
      host.remove();
      mountState = 'idle';
      if (showFallback) {
        let validForFallback = rawText.length <= SMALL_PARSE_LIMIT;
        if (!validForFallback && mime !== 'text/plain') {
          try {
            JSON.parse(rawText);
            validForFallback = true;
          } catch {
            validForFallback = false;
          }
        }
        if (validForFallback) showFallbackBanner(rawText);
      }
    };

    const loadTimer = setTimeout(() => cleanupFailure(true), loadTimeoutMs);

    channel.port1.onmessage = (event) => {
      const type = event.data?.type;
      if (type === 'ACK') {
        acked = true;
        clearTimeout(ackTimer);
        return;
      }
      if (type === 'READY') {
        if (settled) return;
        settled = true;
        clearTimeout(loadTimer);
        clearTimeout(ackTimer);
        restoreNative = hideNativeJsonElements(pre);
        host.style.visibility = 'visible';
        host.style.pointerEvents = 'auto';
        mountState = 'formatted';
        return;
      }
      if (type === 'PARSE_ERROR') {
        cleanupFailure(false);
      }
    };

    iframe.addEventListener('load', () => {
      clearTimeout(loadTimer);
      if (settled) return;
      try {
        const buffer = encoded.buffer;
        iframe.contentWindow.postMessage(
          { type: 'INIT', buffer, url: location.href },
          '*',
          [channel.port2, buffer],
        );
      } catch {
        cleanupFailure(true);
        return;
      }
      ackTimer = setTimeout(() => {
        if (!acked) cleanupFailure(true);
      }, 2500);
    }, { once: true });

    iframe.addEventListener('error', () => cleanupFailure(true), { once: true });
    (document.documentElement || document.body).appendChild(host);
    return { ok: true };
  }

  function detectAndMount({ allowPlainText = false } = {}) {
    if (mountState === 'formatted') return { ok: true, alreadyFormatted: true };
    if (mountState === 'pending') return { ok: true, pending: true };

    const mime = normalizeMime(document.contentType);
    if (!isJsonContentType(mime, allowPlainText)) {
      return { ok: false, reason: 'not-json' };
    }
    const pre = findJsonPreElement(document);
    if (!pre) {
      return { ok: false, reason: 'not-json' };
    }
    const rawText = pre.textContent ?? '';
    if (!hasNonWhitespace(rawText)) {
      return { ok: false, reason: 'not-json' };
    }
    if (mime === 'text/plain' && !looksLikeJsonContainer(rawText)) {
      return { ok: false, reason: 'not-json' };
    }
    if (rawText.length <= SMALL_PARSE_LIMIT) {
      try {
        JSON.parse(rawText);
      } catch {
        return { ok: false, reason: 'not-json' };
      }
    }
    return mountViewer(pre, rawText, mime);
  }

  async function runAutoDetect() {
    if (mountState !== 'idle') return;
    const mime = normalizeMime(document.contentType);
    let allowPlainText = false;
    if (mime === 'text/plain') {
      try {
        const stored = await chrome.storage?.local?.get?.(STORAGE_PLAIN_TEXT_KEY);
        allowPlainText = Boolean(stored?.[STORAGE_PLAIN_TEXT_KEY]);
      } catch {
        allowPlainText = false;
      }
    }
    detectAndMount({ allowPlainText });
  }

  if (globalThis.__JSON_TOOLBOX_DETECT_TEST__) {
    globalThis.__jsonToolboxDetect = {
      isJsonContentType,
      findJsonPreElement,
      looksLikeJsonContainer,
      detectAndMount,
    };
    return;
  }

  if (globalThis.__jsonToolboxDetectInstalled) return;
  globalThis.__jsonToolboxDetectInstalled = true;

  // Fast exit at document_start for non-JSON / non-plain documents (e.g. text/html).
  const initialMime = normalizeMime(document.contentType);
  const maybeAutoCandidate = !initialMime || isJsonContentType(initialMime, true);

  if (maybeAutoCandidate) {
    const startAuto = () => { void runAutoDetect(); };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startAuto, { once: true });
    } else {
      startAuto();
    }
  }

  chrome.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'FORMAT_PAGE_ON_DEMAND') return false;
    const runOnDemand = () => {
      const result = detectAndMount({ allowPlainText: true });
      if (!result.ok) {
        showToast(i18n('errPageNotJson', 'This page is not valid JSON.'));
      }
      sendResponse(result);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', runOnDemand, { once: true });
      return true;
    }
    runOnDemand();
    return false;
  });
})();
