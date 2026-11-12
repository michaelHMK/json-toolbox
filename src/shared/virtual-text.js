import { createPlainTextRows, createDiffTextRows, safeTextWindow } from '../core/text-lines.js';
import { copyText } from './clipboard.js';
import { t } from './i18n.js';

const SMALL_TEXT_LIMIT = 200000;
const SMALL_ROW_LIMIT = 2000;
const LONG_LINE_LIMIT = 8000;
const MAX_SCROLL_SIZE = 8000000;
const OVERSCAN = 8;
const COLUMN_CHUNK = 1024;

// Keep ordinary outputs as native text/DOM so browser selection and Find work.
// Large outputs retain their complete source and index only rows in the viewport.
export function createVirtualTextView(element) {
  let model = null;
  let diffResult = null;
  let virtual = false;
  let destroyed = false;
  let frame = 0;
  let layer = null;
  let spacer = null;
  let rows = [];
  let geometry = new Map();
  let lineHeight = 21;
  let characterWidth = 8;
  let topPadding = 0;
  let bottomPadding = 0;
  let leftPadding = 0;
  let rightPadding = 0;
  let logicalHeight = 0;
  let logicalWidth = 0;
  let physicalHeight = 0;
  let physicalWidth = 0;
  let selectAll = false;
  const originalTabIndex = element.getAttribute('tabindex');
  const originalRole = element.getAttribute('role');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  function metrics() {
    const style = getComputedStyle(element);
    lineHeight = Math.ceil(parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.65 || 21);
    context.font = style.font || `${style.fontSize} ${style.fontFamily}`;
    characterWidth = context.measureText('M').width || 8;
    if (!virtual) {
      topPadding = parseFloat(style.paddingTop) || 0;
      bottomPadding = parseFloat(style.paddingBottom) || 0;
      leftPadding = parseFloat(style.paddingLeft) || 0;
      rightPadding = parseFloat(style.paddingRight) || 0;
    }
  }

  function horizontalGeometry(index, row) {
    let info = geometry.get(index);
    if (info) return info;
    const text = row.prefix + row.text.slice(row.start, row.end);
    const ascii = !/[^\x20-\x7e]/.test(text);
    if (ascii) {
      info = { text, width: text.length * characterWidth, ascii: true };
    } else {
      // Measure bounded chunks instead of giving a multi-megabyte line to layout.
      // A tab advances to the same two-character tab stop used by the viewer.
      const offsets = [0];
      const widths = [0];
      let width = 0;
      let from = 0;
      while (from < text.length) {
        const window = safeTextWindow(text, from, Math.min(text.length, from + COLUMN_CHUNK));
        const chunk = text.slice(from, window.end);
        let segmentStart = 0;
        for (let at = chunk.indexOf('\t'); at !== -1; at = chunk.indexOf('\t', at + 1)) {
          width += context.measureText(chunk.slice(segmentStart, at)).width;
          const tab = characterWidth * 2;
          const next = (Math.floor(width / tab) + 1) * tab;
          // CSS advances another stop when the remaining gap is under half a space.
          width = next - width < characterWidth / 2 ? next + tab : next;
          segmentStart = at + 1;
        }
        width += context.measureText(chunk.slice(segmentStart)).width;
        from = window.end;
        offsets.push(from);
        widths.push(width);
      }
      info = { text, width, ascii: false, offsets, widths };
    }
    geometry.set(index, info);
    logicalWidth = Math.max(logicalWidth, info.width + leftPadding + rightPadding);
    return info;
  }

  function measuredPrefix(info, chunk, offset) {
    const text = info.text.slice(info.offsets[chunk], offset);
    let width = info.widths[chunk];
    let start = 0;
    for (let at = text.indexOf('\t'); at !== -1; at = text.indexOf('\t', at + 1)) {
      width += context.measureText(text.slice(start, at)).width;
      const tab = characterWidth * 2;
      const next = (Math.floor(width / tab) + 1) * tab;
      width = next - width < characterWidth / 2 ? next + tab : next;
      start = at + 1;
    }
    return width + context.measureText(text.slice(start)).width;
  }

  function columnAt(info, x) {
    if (info.ascii) return { offset: Math.max(0, Math.min(info.text.length, Math.floor(x / characterWidth))), x: Math.max(0, Math.floor(x / characterWidth)) * characterWidth };
    if (x <= 0) return { offset: 0, x: 0 };
    if (x >= info.width) return { offset: info.text.length, x: info.width };
    let low = 0;
    let high = info.widths.length - 1;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (info.widths[middle] <= x) low = middle;
      else high = middle;
    }
    const chunk = low;
    low = info.offsets[chunk];
    high = info.offsets[chunk + 1];
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (measuredPrefix(info, chunk, middle) <= x) low = middle;
      else high = middle;
    }
    const safe = safeTextWindow(info.text, low, low);
    return { offset: safe.start, x: measuredPrefix(info, chunk, safe.start) };
  }

  function xAtOffset(info, offset) {
    if (info.ascii) return offset * characterWidth;
    if (offset >= info.text.length) return info.width;
    let low = 0;
    let high = info.offsets.length - 1;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (info.offsets[middle] <= offset) low = middle;
      else high = middle;
    }
    return measuredPrefix(info, low, offset);
  }

  function extents() {
    physicalHeight = Math.min(MAX_SCROLL_SIZE, Math.max(element.clientHeight, logicalHeight));
    physicalWidth = Math.min(MAX_SCROLL_SIZE, Math.max(element.clientWidth, logicalWidth));
    spacer.style.height = `${physicalHeight}px`;
    spacer.style.width = `${physicalWidth}px`;
  }

  function toLogical(position, logical, physical, viewport) {
    return physical <= viewport ? 0 : position * Math.max(0, logical - viewport) / (physical - viewport);
  }

  function setLogicalScroll(x, y) {
    const width = element.clientWidth;
    const height = element.clientHeight;
    element.scrollLeft = logicalWidth <= width ? 0 : Math.max(0, Math.min(logicalWidth - width, x)) * (physicalWidth - width) / (logicalWidth - width);
    element.scrollTop = logicalHeight <= height ? 0 : Math.max(0, Math.min(logicalHeight - height, y)) * (physicalHeight - height) / (logicalHeight - height);
    render();
  }

  function render() {
    if (!virtual || !model || destroyed || !element.clientHeight || !element.clientWidth) return;
    const height = element.clientHeight;
    const width = element.clientWidth;
    extents();
    let top = toLogical(element.scrollTop, logicalHeight, physicalHeight, height);
    let left = toLogical(element.scrollLeft, logicalWidth, physicalWidth, width);
    const first = Math.max(0, Math.floor((top - topPadding) / lineHeight) - OVERSCAN);
    const count = Math.min(model.count - first, Math.ceil(height / lineHeight) + OVERSCAN * 2);
    // Resolve geometry first so a wider Unicode row adjusts the scroll range once.
    const visible = [];
    for (let i = 0; i < count; i++) {
      const row = model.getRow(first + i);
      visible.push({ row, info: horizontalGeometry(first + i, row) });
    }
    extents();
    top = toLogical(element.scrollTop, logicalHeight, physicalHeight, height);
    left = toLogical(element.scrollLeft, logicalWidth, physicalWidth, width);
    layer.style.width = `${width}px`;
    layer.style.height = `${height}px`;
    layer.style.transform = `translate(${element.scrollLeft}px, ${element.scrollTop}px)`;
    while (rows.length < count) {
      const div = document.createElement('div');
      div.className = 'virtual-text-row';
      const text = document.createElement('span');
      div.appendChild(text);
      layer.appendChild(div);
      rows.push({ div, text, value: null });
    }
    while (rows.length > count) rows.pop().div.remove();
    for (let i = 0; i < count; i++) {
      const { row, info } = visible[i];
      const node = rows[i];
      node.index = first + i;
      const start = columnAt(info, Math.max(0, left - leftPadding - 100));
      const end = columnAt(info, Math.max(0, left - leftPadding + width + 100));
      const window = safeTextWindow(info.text, start.offset, Math.min(info.text.length, end.offset + 2));
      const value = info.text.slice(window.start, window.end);
      node.div.className = `virtual-text-row ${row.className}`;
      node.div.style.height = `${lineHeight}px`;
      node.div.style.top = `${topPadding + (first + i) * lineHeight - top}px`;
      node.text.style.transform = `translateX(${leftPadding + start.x - left}px)`;
      node.text.dataset.textOffset = String(row.start + Math.max(0, window.start - row.prefix.length));
      if (node.value !== value) {
        node.text.textContent = value;
        node.value = value;
      }
    }
    // Limit retained geometry to recently visible rows, never every visited line.
    if (geometry.size > count * 4 + 32) {
      const keep = new Map();
      for (let i = 0; i < count; i++) keep.set(first + i, visible[i].info);
      geometry = keep;
    }
  }

  function schedule() {
    if (!frame && !destroyed) frame = requestAnimationFrame(() => { frame = 0; render(); });
  }

  function reset() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    element.classList.remove('virtual-text', 'virtual-text-selected');
    element.replaceChildren();
    element.scrollTop = 0;
    element.scrollLeft = 0;
    if (originalRole === null) element.removeAttribute('role');
    else element.setAttribute('role', originalRole);
    element.removeAttribute('aria-readonly');
    element.removeAttribute('aria-multiline');
    if (originalTabIndex === null) element.removeAttribute('tabindex');
    else element.setAttribute('tabindex', originalTabIndex);
    layer = null;
    spacer = null;
    rows = [];
    geometry.clear();
    selectAll = false;
    virtual = false;
  }

  function setModel(next, plainText) {
    reset();
    model = next;
    metrics();
    virtual = next.count > SMALL_ROW_LIMIT || next.maxLineLength > LONG_LINE_LIMIT ||
      (plainText === undefined ? next.count * next.maxLineLength : plainText.length) > SMALL_TEXT_LIMIT;
    if (!virtual) {
      if (plainText !== undefined) element.textContent = plainText;
      else {
        const fragment = document.createDocumentFragment();
        for (let i = 0; i < next.count; i++) {
          const row = next.getRow(i);
          const div = document.createElement('div');
          div.className = `tline ${row.className}`;
          div.textContent = row.prefix + row.text.slice(row.start, row.end);
          fragment.appendChild(div);
        }
        element.appendChild(fragment);
      }
      return;
    }
    logicalHeight = next.count * lineHeight + topPadding + bottomPadding;
    // UTF-16 length is not rendered width (combining marks/emoji can be much
    // narrower). Grow from measured visible rows, never from an irreversible
    // length estimate that would leave an unreachable blank right-hand tail.
    logicalWidth = leftPadding + rightPadding;
    element.classList.add('virtual-text');
    element.setAttribute('tabindex', '0');
    element.setAttribute('role', 'textbox');
    element.setAttribute('aria-readonly', 'true');
    element.setAttribute('aria-multiline', 'true');
    spacer = document.createElement('div');
    spacer.className = 'virtual-text-spacer';
    spacer.setAttribute('aria-hidden', 'true');
    layer = document.createElement('div');
    layer.className = 'virtual-text-layer';
    element.append(spacer, layer);
    render();
    // A reset followed by programmatic scrolling can coalesce to the previous
    // native offset without a scroll event. Reconcile once before the next paint.
    schedule();
  }

  function refresh() {
    if (destroyed || !virtual || !model) return;
    const previousFont = context.font;
    const previousCharacterWidth = characterWidth;
    metrics();
    if (context.font !== previousFont || characterWidth !== previousCharacterWidth) {
      geometry.clear();
      logicalWidth = leftPadding + rightPadding;
    }
    logicalHeight = model.count * lineHeight + topPadding + bottomPadding;
    render();
  }

  // Locate within the existing row index; neither selecting an error nor
  // revealing EOF should materialize the complete document in the DOM.
  function revealPosition(position) {
    if (destroyed || !model || model.sourceText === undefined || !Number.isFinite(position)) return;
    position = Math.max(0, Math.min(Math.floor(position), model.sourceText.length));
    selectAll = false;
    element.classList.remove('virtual-text-selected');
    element.focus();
    let textNode;
    let offset;
    if (virtual) {
      let low = 0;
      let high = model.count - 1;
      while (low < high) {
        const middle = (low + high + 1) >>> 1;
        if (model.getRow(middle).start <= position) low = middle;
        else high = middle - 1;
      }
      const row = model.getRow(low);
      // CR/LF positions belong to the end of the preceding displayed row.
      const rowOffset = Math.min(position, row.end) - row.start;
      const info = horizontalGeometry(low, row);
      extents();
      setLogicalScroll(Math.max(0, xAtOffset(info, rowOffset) - element.clientWidth / 2),
        Math.max(0, (low - 2) * lineHeight + topPadding));
      const target = rows.find((node) => node.index === low)?.text;
      textNode = target?.firstChild || target;
      offset = row.start + rowOffset - Number(target?.dataset.textOffset);
    } else {
      textNode = element.firstChild || element;
      offset = position;
    }
    if (!textNode) return;
    const selected = safeTextWindow(textNode.textContent, offset, offset + 1);
    const range = document.createRange();
    range.setStart(textNode, selected.start);
    range.setEnd(textNode, selected.end);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function onKeyDown(event) {
    if (!virtual || !model) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      selectAll = true;
      element.classList.add('virtual-text-selected');
      return;
    }
    if (mod && event.key.toLowerCase() === 'c' && selectAll) {
      event.preventDefault();
      void copyText(model.copyText());
      return;
    }
    let x = toLogical(element.scrollLeft, logicalWidth, physicalWidth, element.clientWidth);
    let y = toLogical(element.scrollTop, logicalHeight, physicalHeight, element.clientHeight);
    if (event.key === 'End' && mod) {
      const last = model.getRow(model.count - 1);
      const info = horizontalGeometry(model.count - 1, last);
      extents();
      y = logicalHeight;
      x = Math.max(0, info.width + leftPadding + rightPadding - element.clientWidth);
    } else if (event.key === 'Home' && mod) { x = 0; y = 0; }
    else if (event.key === 'ArrowDown') y += lineHeight;
    else if (event.key === 'ArrowUp') y -= lineHeight;
    else if (event.key === 'PageDown') y += element.clientHeight - lineHeight;
    else if (event.key === 'PageUp') y -= element.clientHeight - lineHeight;
    else if (event.key === 'ArrowRight') x += characterWidth * 3;
    else if (event.key === 'ArrowLeft') x -= characterWidth * 3;
    else return;
    event.preventDefault();
    setLogicalScroll(x, y);
  }

  function onCopy(event) {
    if (!virtual || !model) return;
    if (selectAll) {
      event.preventDefault();
      event.clipboardData.setData('text/plain', model.copyText());
      return;
    }
    if (model.sourceText === undefined) return;
    const selection = document.getSelection();
    const anchor = selection?.anchorNode;
    const focus = selection?.focusNode;
    if (anchor?.nodeType !== 3 || focus?.nodeType !== 3) return;
    const a = anchor.parentElement;
    const b = focus.parentElement;
    if (!layer.contains(a) || !layer.contains(b) || a.dataset.textOffset === undefined || b.dataset.textOffset === undefined) return;
    const start = Number(a.dataset.textOffset) + selection.anchorOffset;
    const end = Number(b.dataset.textOffset) + selection.focusOffset;
    event.preventDefault();
    event.clipboardData.setData('text/plain', model.sourceText.slice(Math.min(start, end), Math.max(start, end)));
  }

  function onPointerDown() {
    selectAll = false;
    element.classList.remove('virtual-text-selected');
  }

  element.addEventListener('scroll', schedule, { passive: true });
  element.addEventListener('keydown', onKeyDown);
  element.addEventListener('copy', onCopy);
  element.addEventListener('pointerdown', onPointerDown);
  const resize = new ResizeObserver(() => refresh());
  resize.observe(element);
  return {
    setText(text) {
      if (model && diffResult === null && model.sourceText === text) { refresh(); return; }
      diffResult = null;
      setModel(createPlainTextRows(text), text);
    },
    setDiff(result) {
      if (model && diffResult === result) { refresh(); return; }
      diffResult = result;
      setModel(createDiffTextRows(result, {
        gapText: (count) => t('textDiffGap', [String(count)]),
        blockyText: t('textDiffBlockyNote'),
      }));
    },
    refresh,
    revealPosition,
    clear() { reset(); model = null; diffResult = null; },
    destroy() {
      reset();
      model = null;
      diffResult = null;
      destroyed = true;
      resize.disconnect();
      element.removeEventListener('scroll', schedule);
      element.removeEventListener('keydown', onKeyDown);
      element.removeEventListener('copy', onCopy);
      element.removeEventListener('pointerdown', onPointerDown);
    },
  };
}
