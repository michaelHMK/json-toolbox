import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/shared/i18n.js', import.meta.url), 'utf8')
  .replace(/^export /gm, '');

function setup({ messages, language = 'en' } = {}) {
  const control = {
    attributes: {
      'data-i18n': 'btnCopy',
      'data-i18n-title': 'btnCopy',
      'data-i18n-placeholder': 'btnCopy',
      'data-i18n-aria-label': 'btnCopy',
      'aria-label': 'Copy result',
    },
    textContent: 'Copy result',
    title: 'Copy result',
    placeholder: 'Copy result',
    getAttribute(name) { return this.attributes[name]; },
    setAttribute(name, value) { this.attributes[name] = value; },
  };
  const root = { lang: 'en', dir: 'ltr' };
  const context = vm.createContext({
    document: {
      documentElement: root,
      querySelectorAll: () => [control],
    },
    ...(messages && { chrome: { i18n: {
      getMessage: (key) => messages[key] || '',
      getUILanguage: () => language,
    } } }),
  });
  vm.runInContext(source + '\nglobalThis.apply = applyI18n;', context);
  return { control, root, apply: context.apply };
}

test('Arabic uses RTL and translates accessible names with visible labels', () => {
  const page = setup({ language: 'ar', messages: { '@@bidi_dir': 'rtl', btnCopy: 'نسخ النتيجة' } });
  page.apply();
  assert.equal(page.root.lang, 'ar');
  assert.equal(page.root.dir, 'rtl');
  assert.equal(page.control.textContent, 'نسخ النتيجة');
  assert.equal(page.control.getAttribute('aria-label'), page.control.textContent);
  assert.equal(page.control.title, page.control.textContent);
  assert.equal(page.control.placeholder, page.control.textContent);
});

test('LTR locales restore document direction and tolerate a missing bidi message', () => {
  for (const direction of ['ltr', '']) {
    const page = setup({ language: 'fr', messages: { '@@bidi_dir': direction, btnCopy: 'Copier le résultat' } });
    page.root.dir = 'rtl';
    page.apply();
    assert.equal(page.root.dir, 'ltr');
    assert.equal(page.root.lang, 'fr');
    assert.equal(page.control.getAttribute('aria-label'), 'Copier le résultat');
  }
});

test('without the extension API the English static labels remain usable', () => {
  const page = setup();
  page.apply();
  assert.equal(page.root.lang, 'en');
  assert.equal(page.root.dir, 'ltr');
  assert.equal(page.control.textContent, 'Copy result');
  assert.equal(page.control.getAttribute('aria-label'), 'Copy result');
});
