import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/shared/theme.js', import.meta.url), 'utf8');
const key = 'json-toolbox.theme';

function openPage({ values = new Map(), blocked = '' } = {}) {
  const documentEvents = {};
  const windowEvents = {};
  const buttons = [];
  let focusedControl;
  const makeControl = ({ dataset = {}, hidden = false } = {}) => {
    const events = {};
    return {
      dataset,
      hidden,
      attributes: {},
      textContent: '',
      setAttribute(name, value) { this.attributes[name] = value; },
      getAttribute(name) { return this.attributes[name]; },
      addEventListener(name, handler) { events[name] = handler; },
      focus() { focusedControl = this; documentEvents.focusin?.({ target: this }); },
      click() {
        events.click?.({ target: this });
        documentEvents.click?.({ target: this });
      },
      closest(selector) { return selector === '.theme-picker' ? this : null; },
    };
  };
  const trigger = makeControl();
  trigger.setAttribute('aria-expanded', 'false');
  const menu = makeControl({ hidden: true });
  const current = makeControl();
  const controls = { '#theme-trigger': trigger, '#theme-switch': menu, '#theme-current': current };
  const storage = {
    getItem(name) {
      if (blocked === 'read') throw new Error('Storage read blocked');
      return values.get(name) ?? null;
    },
    setItem(name, value) {
      if (blocked === 'write') throw new Error('Storage write blocked');
      values.set(name, value);
    },
  };
  const document = {
    documentElement: { dataset: {} },
    querySelector: selector => {
      if (controls[selector]) return controls[selector];
      const match = selector.match(/data-theme-option="(\w+)"/);
      return buttons.find(button => button.dataset.themeOption === match?.[1]);
    },
    querySelectorAll: () => buttons,
    addEventListener: (name, handler) => { documentEvents[name] = handler; },
  };
  const window = {
    get localStorage() {
      if (blocked === 'access') throw new Error('Storage unavailable');
      return storage;
    },
    addEventListener: (name, handler) => { windowEvents[name] = handler; },
  };
  vm.runInNewContext(source, { document, window });
  const startupTheme = document.documentElement.dataset.theme;
  // The navigation is rendered later by the deferred page module.
  for (const [theme, label, fallback] of [
    ['normal', 'themeNormal', 'Normal'],
    ['comfort', 'themeComfort', 'Eye comfort'],
    ['dark', 'themeDark', 'Dark'],
  ]) {
    const button = makeControl({ dataset: { themeOption: theme, themeLabel: label } });
    const name = { textContent: fallback };
    button.querySelector = selector => selector === '.theme-option-name' ? name : null;
    buttons.push(button);
  }
  documentEvents.DOMContentLoaded();
  return {
    startupTheme,
    get theme() { return document.documentElement.dataset.theme; },
    get selected() { return buttons.filter(button => button.attributes['aria-pressed'] === 'true').map(button => button.dataset.themeOption); },
    get menuHidden() { return menu.hidden; },
    get expanded() { return trigger.attributes['aria-expanded']; },
    get active() { return focusedControl; },
    get trigger() { return trigger; },
    get currentLabel() { return current.textContent; },
    get currentThemeKey() { return current.dataset.i18n; },
    openMenu: () => trigger.click(),
    click: theme => buttons.find(button => button.dataset.themeOption === theme).click(),
    keydown: key => documentEvents.keydown({ key, preventDefault() {} }),
    outsideClick: () => documentEvents.click({ target: { closest: () => null } }),
    outsideFocus: () => documentEvents.focusin({ target: { closest: () => null } }),
    storageEvent: event => windowEvents.storage({ storageArea: storage, ...event }),
    values,
  };
}

test('new users and invalid preferences start in normal mode without writing storage', () => {
  for (const saved of [undefined, '', 'system', 'invalid']) {
    const values = new Map(saved === undefined ? [] : [[key, saved]]);
    const before = [...values];
    const page = openPage({ values });
    assert.equal(page.startupTheme, 'normal');
    assert.deepEqual(page.selected, ['normal']);
    assert.deepEqual([...values], before);
  }
});

test('each selected mode persists and is restored before the next page renders', () => {
  const values = new Map([['unrelated', 'keep']]);
  const page = openPage({ values });
  for (const mode of ['comfort', 'dark', 'normal']) {
    page.click(mode);
    assert.equal(page.theme, mode);
    assert.deepEqual(page.selected, [mode]);
    assert.equal(values.get(key), mode);
    assert.deepEqual([...values.keys()], ['unrelated', key]);
    const nextPage = openPage({ values });
    assert.equal(nextPage.startupTheme, mode);
    assert.deepEqual(nextPage.selected, [mode]);
    assert.equal(nextPage.currentLabel, { normal: 'Normal', comfort: 'Eye comfort', dark: 'Dark' }[mode]);
  }
});

test('preview dialog manages focus and closes on selection, Escape, outside click or focus', () => {
  const page = openPage();
  assert.equal(page.menuHidden, true);
  assert.equal(page.expanded, 'false');
  page.openMenu();
  assert.equal(page.menuHidden, false);
  assert.equal(page.expanded, 'true');
  assert.equal(page.active.dataset.themeOption, 'normal');
  page.click('dark');
  assert.equal(page.menuHidden, true);
  assert.equal(page.expanded, 'false');
  assert.equal(page.currentLabel, 'Dark');
  assert.equal(page.currentThemeKey, 'themeDark');
  assert.equal(page.active, page.trigger);
  page.openMenu();
  assert.equal(page.active.dataset.themeOption, 'dark');
  page.keydown('Escape');
  assert.equal(page.menuHidden, true);
  assert.equal(page.active, page.trigger);
  for (const close of ['outsideClick', 'outsideFocus']) {
    page.openMenu();
    page[close]();
    assert.equal(page.menuHidden, true);
    assert.equal(page.expanded, 'false');
  }
});

test('open pages follow theme changes and removals in local storage only', () => {
  const page = openPage({ values: new Map([[key, 'comfort']]) });
  page.storageEvent({ key, newValue: 'dark' });
  assert.equal(page.theme, 'dark');
  assert.deepEqual(page.selected, ['dark']);
  assert.equal(page.currentLabel, 'Dark');
  page.storageEvent({ key: 'unrelated', newValue: 'normal' });
  page.storageEvent({ key, newValue: 'normal', storageArea: {} });
  assert.equal(page.theme, 'dark');
  for (const event of [{ key, newValue: null }, { key, newValue: 'invalid' }, { key: null, newValue: null }]) {
    page.click('comfort');
    page.storageEvent(event);
    assert.equal(page.theme, 'normal');
    assert.deepEqual(page.selected, ['normal']);
  }
});

test('blocked storage does not break initial rendering or manual theme selection', () => {
  for (const blocked of ['access', 'read', 'write']) {
    const page = openPage({ blocked });
    assert.equal(page.startupTheme, 'normal');
    page.click('dark');
    assert.equal(page.theme, 'dark');
    assert.deepEqual(page.selected, ['dark']);
    assert.equal(page.menuHidden, true);
    page.click('comfort');
    assert.deepEqual(page.selected, ['comfort']);
  }
});
