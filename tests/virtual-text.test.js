import test from 'node:test';
import assert from 'node:assert/strict';
import { createTextLines, createPlainTextRows, createDiffTextRows, safeTextWindow } from '../src/core/text-lines.js';

const textOf = (row) => row.prefix + row.text.slice(row.start, row.end);

test('line offsets preserve empty/trailing lines, CRLF and standalone CR without altering copied text', () => {
  for (const [text, expected] of [
    ['', ['']], ['one', ['one']], ['a\nb\n', ['a', 'b', '']],
    ['a\r\nb\rc\n', ['a', 'b', 'c', '']], ['\r\r\n', ['', '', '']],
  ]) {
    const lines = createTextLines(text);
    assert.ok(lines.starts instanceof Uint32Array);
    assert.deepEqual(Array.from({ length: lines.count }, (_, i) => textOf(lines.bounds(i))), expected);
    const rows = createPlainTextRows(text);
    assert.equal(rows.copyText(), text);
    assert.equal(rows.maxLineLength, Math.max(...expected.map((line) => line.length)));
  }
});

test('offset windows never return half of a surrogate pair', () => {
  const text = 'a😀b';
  assert.deepEqual(safeTextWindow(text, 2, 3), { start: 1, end: 3 });
  assert.deepEqual(safeTextWindow(text, 0, 2), { start: 0, end: 3 });
  assert.deepEqual(safeTextWindow(text, 3, 4), { start: 3, end: 4 });
});

test('large diff blocks have no 50000-row truncation and retain constant-size segments', () => {
  const count = 60000;
  const aText = Array.from({ length: count }, (_, i) => `left ${i}`).join('\n');
  const bText = Array.from({ length: count }, (_, i) => `right ${i}`).join('\n');
  const rows = createDiffTextRows({ aText, bText, ops: [
    { type: 'del', aStart: 0, count }, { type: 'add', bStart: 0, count },
  ], blocky: true }, { blockyText: 'block replacement' });
  assert.equal(rows.count, 120001);
  assert.equal(rows.segmentCount, 3);
  assert.equal(textOf(rows.getRow(0)), '- left 0');
  assert.equal(textOf(rows.getRow(59999)), '- left 59999');
  assert.equal(textOf(rows.getRow(60000)), '+ right 0');
  assert.equal(textOf(rows.getRow(119999)), '+ right 59999');
  assert.equal(textOf(rows.getRow(120000)), 'block replacement');
});

test('unchanged diff segments retain three context lines at either end and gap text', () => {
  const text = Array.from({ length: 30 }, (_, i) => String(i)).join('\n');
  const rows = createDiffTextRows({ aText: text, bText: text, ops: [
    { type: 'same', aStart: 0, bStart: 0, count: 30 },
  ] }, { gapText: (count) => `${count} omitted` });
  assert.equal(rows.count, 7);
  assert.equal(rows.copyText(), '  0\n  1\n  2\n24 omitted\n  27\n  28\n  29');
  assert.equal(rows.getRow(3).className, 'gap');
});

test('the real text component keeps a bounded viewport, reaches the end and copies its whole source', async () => {
  const { loadPage } = await import('./helpers/page-dom.js');
  const page = loadPage('formatter', { expose: '{ outputView }' });
  const element = page.get('output-text');
  const source = 'ordinary\n'.repeat(60000) + 'FINAL';
  page.outputView.setText(source);
  assert.ok(element.classList.contains('virtual-text'));
  assert.ok(element.querySelectorAll('.virtual-text-row').length < 60);
  element.events.keydown({ key: 'End', ctrlKey: true, preventDefault() {} });
  assert.match(element.textContent, /FINAL/);
  const previousScroll = element.scrollTop;
  const layer = element.children[1];
  page.outputView.setText(source);
  assert.equal(element.scrollTop, previousScroll, 'showing the same source must not reset the viewport');
  assert.equal(element.children[1], layer, 'cached source retains its indexed view');
  element.events.keydown({ key: 'a', ctrlKey: true, preventDefault() {} });
  let copied;
  element.events.copy({ preventDefault() {}, clipboardData: { setData(type, text) { copied = text; } } });
  assert.equal(copied, source);
  page.outputView.clear();
  assert.equal(element.textContent, '');
  assert.equal(element.children.length, 0);
  page.outputView.setText('small native output');
  assert.equal(element.classList.contains('virtual-text'), false);
  assert.equal(element.textContent, 'small native output');
  page.outputView.destroy();
});

test('position reveal handles horizontal windows, surrogate pairs, CRLF and EOF in bounded DOM', async () => {
  const { loadPage } = await import('./helpers/page-dom.js');
  const page = loadPage('formatter', { expose: '{ outputView }' });
  const element = page.get('output-text');
  const prefix = 'ordinary\r\n'.repeat(10000) + 'x'.repeat(10000);
  const source = prefix + '😀TARGET\r\n';
  page.outputView.setText(source);
  for (const [position, expected, collapsed] of [
    [prefix.length + 1, '😀', false],
    [source.length - 2, '', true],
    [source.length - 1, '', true],
    [source.length, '', true],
  ]) {
    page.outputView.revealPosition(position);
    const [range] = page.selection.ranges;
    assert.ok(range, `selection exists at ${position}`);
    assert.equal(range.startContainer.textContent.slice(range.startOffset, range.endOffset), expected);
    assert.equal(range.startOffset === range.endOffset, collapsed);
    assert.ok(element.querySelectorAll('.virtual-text-row').length < 60);
  }
  assert.equal(element.focused, true);
  page.outputView.revealPosition(prefix.length + 2);
  assert.match(element.textContent, /TARGET/);
  assert.ok(element.scrollTop > 0);
  assert.ok(element.scrollLeft > 0);
  const [range] = page.selection.ranges;
  assert.equal(Number(range.startContainer.parentElement.dataset.textOffset) + range.startOffset, prefix.length + 2);
  page.outputView.destroy();
});

test('switching between virtual and native output preserves its named focusable region', async () => {
  const { loadPage, Element } = await import('./helpers/page-dom.js');
  const page = loadPage('formatter', { expose: '{ createVirtualTextView }' });
  const element = new Element('pre');
  element.setAttribute('role', 'region');
  element.setAttribute('tabindex', '0');
  element.setAttribute('aria-label', 'Result');
  const view = page.createVirtualTextView(element);
  view.setText('line\n'.repeat(3000));
  assert.equal(element.getAttribute('role'), 'textbox');
  assert.equal(element.getAttribute('aria-multiline'), 'true');
  assert.equal(element.getAttribute('aria-readonly'), 'true');
  view.setText('small result');
  assert.equal(element.getAttribute('role'), 'region');
  assert.equal(element.getAttribute('tabindex'), '0');
  assert.equal(element.getAttribute('aria-label'), 'Result');
  assert.equal(element.getAttribute('aria-readonly'), null);
  assert.equal(element.getAttribute('aria-multiline'), null);
  view.destroy();
});
