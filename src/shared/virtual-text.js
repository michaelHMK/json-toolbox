import { createPlainTextRows, createDiffTextRows, safeTextWindow } from '../core/text-lines.js';
import { copyText } from './clipboard.js';
import { t } from './i18n.js';

const SMALL_TEXT_LIMIT = 200000;
const SMALL_ROW_LIMIT = 2000;
const LONG_LINE_LIMIT = 8000;
const MAX_SCROLL_SIZE = 8000000;
const OVERSCAN = 8;
const COLUMN_CHUNK = 1024;
const WIDTH_INDEX_FRAME_MS = 4;

// Keep ordinary outputs as native text/DOM so browser selection and Find work.
// Large outputs retain their complete source and index only rows in the viewport.
export function createVirtualTextView(element, { copy = copyText } = {}) {
  let model = null;
  let diffResult = null;
  let virtual = false;
  let destroyed = false;
  let frame = 0;
  let resizePending = false;
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
  let previousViewportWidth = 0;
  let horizontalAnchor = null;
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

  function asciiWithLeadingTabs(text, prefixLength) {
    // JSON strings cannot contain raw tabs, so tab-indented JSON only has
    // leading tabs (after an optional even-width diff prefix such as "  "/"+ "/"- ").
    if (prefixLength % 2 !== 0) return -1;
    for (let i = 0; i < prefixLength; i++) {
      const c = text.charCodeAt(i);
      if (c < 0x20 || c > 0x7e) return -1;
    }
    let leadTabs = 0;
    while (prefixLength + leadTabs < text.length && text.charCodeAt(prefixLength + leadTabs) === 9) leadTabs++;
    if (leadTabs === 0) return -1;
    for (let i = prefixLength + leadTabs; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c < 0x20 || c > 0x7e) return -1;
    }
    return leadTabs;
  }

  function horizontalGeometry(index, row) {
    let info = geometry.get(index);
    if (info) return info;
    const text = row.prefix + row.text.slice(row.start, row.end);
    const singleLongRow = model.count === 1 && text.length > LONG_LINE_LIMIT;
    const ascii = singleLongRow && typeof row.ascii === 'boolean'
      ? row.ascii : row.ascii === true || !/[^\x20-\x7e]/.test(text);
    const leadTabs = !ascii && !singleLongRow ? asciiWithLeadingTabs(text, row.prefix.length) : -1;
    // A single long row can use source offsets for its entire scroll track.
    // Its position then never depends on how much of a Unicode prefix was measured.
    const byOffset = singleLongRow && !ascii;
    if (ascii || byOffset) {
      info = { text, width: text.length * characterWidth, ascii, byOffset };
    } else if (leadTabs > 0) {
      info = { text, width: (text.length + leadTabs) * characterWidth, ascii: false, leadTabs, tabStart: row.prefix.length };
    } else {
      info = { text, width: 0, ascii: false, offsets: [0], widths: [0] };
      extendWidthIndex(info);
    }
    geometry.set(index, info);
    logicalWidth = Math.max(logicalWidth, info.width + leftPadding + rightPadding);
    return info;
  }

  function measureRun(text, width = 0) {
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

  function measuredPrefix(info, chunk, offset) {
    return measureRun(info.text.slice(info.offsets[chunk], offset), info.widths[chunk]);
  }

  function extendWidthIndex(info, updateExtent = true) {
    const chunk = info.offsets.length - 1;
    const from = info.offsets[chunk];
    const end = safeTextWindow(info.text, from, from + COLUMN_CHUNK).end;
    info.width = measuredPrefix(info, chunk, end);
    info.offsets.push(end);
    info.widths.push(info.width);
    if (updateExtent) logicalWidth = Math.max(logicalWidth, info.width + leftPadding + rightPadding);
  }

  function needsWidthIndex(info) {
    return !!info.offsets && info.offsets.at(-1) < info.text.length;
  }

  function columnAt(info, x) {
    if (info.ascii) return { offset: Math.max(0, Math.min(info.text.length, Math.floor(x / characterWidth))), x: Math.max(0, Math.floor(x / characterWidth)) * characterWidth };
    if (info.leadTabs) {
      const col = Math.max(0, Math.floor(x / characterWidth));
      const { tabStart, leadTabs } = info;
      const tabEndCol = tabStart + leadTabs * 2;
      if (col <= tabStart) {
        const offset = Math.min(info.text.length, col);
        return { offset, x: offset * characterWidth };
      }
      if (col < tabEndCol) {
        const tabs = Math.floor((col - tabStart) / 2);
        return { offset: tabStart + tabs, x: (tabStart + tabs * 2) * characterWidth };
      }
      const offset = Math.min(info.text.length, col - leadTabs);
      return { offset, x: (offset + leadTabs) * characterWidth };
    }
    if (x <= 0) return { offset: 0, x: 0 };
    if (x >= info.width) return { offset: info.offsets.at(-1), x: info.width };
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

  function pixelWindow(info, left, width) {
    const start = columnAt(info, Math.max(0, left - leftPadding - 100));
    // Keep sliced diff prefixes at an even column before leading tabs so CSS tab-size: 2 stays aligned.
    if (info.leadTabs && start.offset === 1 && info.tabStart === 2) {
      start.offset = 0;
      start.x = 0;
    }
    const end = columnAt(info, Math.max(0, left - leftPadding + width + 100));
    return { ...safeTextWindow(info.text, start.offset, end.offset + 2), x: leftPadding + start.x - left };
  }

  function rowWindow(info, left, width) {
    if (!info.byOffset) return pixelWindow(info, left, width);
    const fraction = Math.min(1, left / Math.max(1, logicalWidth - width));
    const { text } = info;
    const offset = Math.round(fraction * text.length);
    const anchor = safeTextWindow(text, offset, offset).start;
    const anchorX = leftPadding + fraction * (width - leftPadding - rightPadding);
    // A local slice usually fills the viewport, even with wide or joined glyphs.
    let radius = Math.max(COLUMN_CHUNK, Math.ceil(width / characterWidth));
    const limit = Math.max(radius, LONG_LINE_LIMIT);
    for (;;) {
      const { start, end } = safeTextWindow(text, anchor - radius, anchor + radius);
      const before = measureRun(text.slice(start, anchor));
      const x = anchorX - before;
      const coversLeft = start === 0 || x <= -100;
      const coversRight = end === text.length || x + measureRun(text.slice(anchor, end), before) >= width + 100;
      const local = { start, end, x, alignEnd: anchor === text.length };
      const wholeRow = start === 0 && end === text.length;
      if (coversLeft && coversRight && !wholeRow) return local;
      if (radius === limit || wholeRow) return sparseWindow(info, anchor, anchorX, width) ?? local;
      radius = Math.min(limit, radius * 2);
    }
  }

  function sparseWindow(info, anchor, anchorX, width) {
    // A run of combining marks may occupy only a few pixels. Fill a viewport
    // from the exact index in frame-sized batches without moving the native thumb.
    const exact = info.exact ??= { text: info.text, width: 0, offsets: [0], widths: [0] };
    const deadline = Date.now() + WIDTH_INDEX_FRAME_MS;
    while (needsWidthIndex(exact) && Date.now() < deadline) extendWidthIndex(exact, false);
    const pending = needsWidthIndex(exact);
    const exactWidth = exact.width + leftPadding + rightPadding;
    if (pending) schedule();
    if (exact.offsets.at(-1) < anchor) return null;
    const anchorPixel = xAtOffset(exact, anchor);
    if (pending && exact.width - anchorPixel < width - anchorX) return null;
    const left = Math.max(0, Math.min(exactWidth - width, leftPadding + anchorPixel - anchorX));
    if (!pending) {
      // Narrow rows can fit almost entirely on screen. Adopt their real scroll
      // range once, keeping the same source character at its screen position.
      geometry.set(0, exact);
      logicalWidth = exactWidth;
      extents();
      setHorizontalScroll(left);
    }
    return pixelWindow(exact, left, width);
  }

  function xAtOffset(info, offset) {
    if (info.ascii || info.byOffset) return offset * characterWidth;
    if (info.leadTabs) {
      const { tabStart, leadTabs } = info;
      if (offset <= tabStart) return offset * characterWidth;
      if (offset <= tabStart + leadTabs) return (tabStart + (offset - tabStart) * 2) * characterWidth;
      return (offset + leadTabs) * characterWidth;
    }
    // An explicit error-location or End jump needs the exact source coordinate.
    while (info.offsets.at(-1) < offset) extendWidthIndex(info);
    if (offset >= info.offsets.at(-1)) return info.width;
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
    physicalHeight = Math.min(MAX_SCROLL_SIZE, logicalHeight);
    physicalWidth = Math.min(MAX_SCROLL_SIZE, logicalWidth);
    spacer.style.height = `${physicalHeight}px`;
    spacer.style.width = `${physicalWidth}px`;
  }

  function toLogical(position, logical, physical, viewport) {
    return physical <= viewport ? 0 : position * Math.max(0, logical - viewport) / (physical - viewport);
  }

  function logicalLeft() {
    const width = element.clientWidth;
    if (horizontalAnchor?.scrollLeft === element.scrollLeft) return Math.max(0, Math.min(horizontalAnchor.x, logicalWidth - width));
    return toLogical(element.scrollLeft, logicalWidth, physicalWidth, width);
  }

  function setHorizontalScroll(x) {
    const width = element.clientWidth;
    x = Math.max(0, Math.min(logicalWidth - width, x));
    element.scrollLeft = logicalWidth <= width ? 0 : x * (physicalWidth - width) / (logicalWidth - width);
    // Native scrollLeft rounds to pixels. Preserve the source coordinate while
    // the growing index rescales a capped scrollbar, including active selections.
    horizontalAnchor = { x, scrollLeft: element.scrollLeft };
  }

  function setLogicalScroll(x, y) {
    const height = element.clientHeight;
    setHorizontalScroll(x);
    element.scrollTop = logicalHeight <= height ? 0 : Math.max(0, Math.min(logicalHeight - height, y)) * (physicalHeight - height) / (logicalHeight - height);
    render();
  }

  function render(advanceIndex = false) {
    if (!virtual || !model || destroyed || !element.clientHeight || !element.clientWidth) return;
    const height = element.clientHeight;
    const width = element.clientWidth;
    extents();
    // Keep a manually reached line end visible when the pane changes width.
    if (previousViewportWidth && previousViewportWidth !== width && physicalWidth > previousViewportWidth &&
        horizontalAnchor?.scrollLeft !== element.scrollLeft &&
        Math.abs(element.scrollLeft - (physicalWidth - previousViewportWidth)) <= 1) {
      element.scrollLeft = Math.max(0, physicalWidth - width);
    }
    previousViewportWidth = width;
    let top = toLogical(element.scrollTop, logicalHeight, physicalHeight, height);
    let left = logicalLeft();
    const first = Math.max(0, Math.floor((top - topPadding) / lineHeight) - OVERSCAN);
    const count = Math.min(model.count - first, Math.ceil(height / lineHeight) + OVERSCAN * 2);
    const oldWidth = logicalWidth;
    // Native scrolling to the right edge follows the growing range. A keyboard
    // jump or revealed selection stays at its source coordinate, even if that
    // coordinate happens to land on the current edge.
    const followRightEdge = horizontalAnchor?.scrollLeft !== element.scrollLeft &&
      physicalWidth > width && element.scrollLeft >= physicalWidth - width - 1;
    // Only the first chunk of a newly visible Unicode line is needed to paint.
    // Grow its exact width in later frames even when the user does not scroll.
    const visible = [];
    for (let i = 0; i < count; i++) {
      const row = model.getRow(first + i);
      visible.push({ row, info: horizontalGeometry(first + i, row) });
    }
    const pending = visible.filter(({ info }) => needsWidthIndex(info));
    if (advanceIndex && pending.length) {
      const deadline = Date.now() + WIDTH_INDEX_FRAME_MS;
      // Combining marks can make a chunk narrower than the viewport. Finish
      // the visible slice of each line before extending the offscreen index.
      for (const target of [left + width + 100, Infinity]) {
        for (const { info } of pending) {
          while (needsWidthIndex(info) && info.width < target && Date.now() < deadline) extendWidthIndex(info);
        }
      }
    }
    if (pending.some(({ info }) => needsWidthIndex(info))) schedule();
    extents();
    if (logicalWidth > oldWidth) {
      if (followRightEdge) {
        horizontalAnchor = null;
        element.scrollLeft = physicalWidth;
      } else setHorizontalScroll(left);
    }
    top = toLogical(element.scrollTop, logicalHeight, physicalHeight, height);
    left = logicalLeft();
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
      const window = rowWindow(info, left, width);
      const value = info.text.slice(window.start, window.end);
      node.div.className = `virtual-text-row ${row.className}`;
      node.div.style.height = `${lineHeight}px`;
      node.div.style.top = `${topPadding + (first + i) * lineHeight - top}px`;
      // Let layout align the final glyph even if canvas and DOM shaping differ.
      node.text.style.transform = window.alignEnd
        ? `translateX(calc(${width - rightPadding}px - 100%))` : `translateX(${window.x}px)`;
      node.text.dataset.textOffset = String(row.start + Math.max(0, window.start - row.prefix.length));
      if (node.value !== value) {
        node.text.textContent = value;
        node.value = value;
      }
    }
    layer.style.transform = `translate(${element.scrollLeft}px, ${element.scrollTop}px)`;
    // Limit retained geometry to recently visible rows, never every visited line.
    if (geometry.size > count * 4 + 32) {
      const keep = new Map();
      for (let i = 0; i < count; i++) keep.set(first + i, visible[i].info);
      geometry = keep;
    }
  }

  function schedule() {
    if (!frame && !destroyed) frame = requestAnimationFrame(() => {
      frame = 0;
      if (resizePending) {
        resizePending = false;
        refresh();
      } else render(true);
    });
  }

  function reset() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    resizePending = false;
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
    previousViewportWidth = 0;
    horizontalAnchor = null;
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
    // Multi-row text shares a pixel coordinate across the visible rows.
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
      horizontalAnchor = null;
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
      let left;
      if (info.byOffset) {
        left = rowOffset / info.text.length * (logicalWidth - element.clientWidth);
      } else {
        const x = xAtOffset(info, rowOffset);
        // Measure enough following text to center the selection on its first paint.
        while (needsWidthIndex(info) && info.width < x + element.clientWidth) extendWidthIndex(info);
        left = x - element.clientWidth / 2;
      }
      extents();
      setLogicalScroll(left, Math.max(0, (low - 2) * lineHeight + topPadding));
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
      void copy(model.copyText());
      return;
    }
    let x = logicalLeft();
    let y = toLogical(element.scrollTop, logicalHeight, physicalHeight, element.clientHeight);
    if (event.key === 'End' && mod) {
      const last = model.getRow(model.count - 1);
      const info = horizontalGeometry(model.count - 1, last);
      const endX = xAtOffset(info, info.text.length);
      extents();
      y = logicalHeight;
      x = Math.max(0, endX + leftPadding + rightPadding - element.clientWidth);
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
  // A scrollbar can resize the observed content box. Write layout in the next
  // frame, after ResizeObserver has finished delivering the current sizes.
  const resize = new ResizeObserver(() => {
    if (virtual) {
      resizePending = true;
      schedule();
    }
  });
  resize.observe(element);
  return {
    setText(text, lineIndex) {
      if (model && diffResult === null && model.sourceText === text) { refresh(); return; }
      diffResult = null;
      setModel(createPlainTextRows(text, lineIndex), text);
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
