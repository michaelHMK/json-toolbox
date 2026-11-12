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
  for (const theme of ['normal', 'comfort', 'dark']) {
    const events = {};
    buttons.push({
      dataset: { themeOption: theme },
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, handler) { events[name] = handler; },
      click() { events.click(); },
    });
  }
  documentEvents.DOMContentLoaded();
  return {
    startupTheme,
    get theme() { return document.documentElement.dataset.theme; },
    get selected() { return buttons.filter(button => button.attributes['aria-pressed'] === 'true').map(button => button.dataset.themeOption); },
    click: theme => buttons.find(button => button.dataset.themeOption === theme).click(),
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
  }
});

test('open pages follow theme changes and removals in local storage only', () => {
  const page = openPage({ values: new Map([[key, 'comfort']]) });
  page.storageEvent({ key, newValue: 'dark' });
  assert.equal(page.theme, 'dark');
  assert.deepEqual(page.selected, ['dark']);
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
    page.click('comfort');
    assert.deepEqual(page.selected, ['comfort']);
  }
});
