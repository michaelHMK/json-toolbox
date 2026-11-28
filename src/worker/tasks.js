import { formatJson, parseJsonPreservingNumberLiterals, collectNumberLiterals } from '../core/json.js';
import { convertLenientJson } from '../core/lenient-json.js';
import { emitYaml } from '../core/yaml-emit.js';
import { yamlToJson } from '../core/yaml-to-json.js';
import { escapeJsonString, unescapeJsonString } from '../core/escape.js';
import { searchData } from '../core/search.js';
import { diffData } from '../core/structural-diff.js';
import { diffFormattedText } from '../core/text-diff.js';
import { parseErrorLocation } from '../core/parse-error.js';
import { createTreeTasks } from './tree-tasks.js';
import { createTextLineIndex } from '../core/text-lines.js';

const TEXT_INDEX_THRESHOLD = 256 * 1024;

/**
 * 一次 Worker 会话的任务入口。所有解析对象图均留在 Worker 内，仅通过树窗口、
 * 搜索结果、差异摘要或格式化文本返回给页面；retainSnapshot 显式保留当前文档/对比供
 * 视图切换复用；snapshotId 防止旧请求读到新数据；clear 释放数据及快照。
 * 输入 { id, action, text, ... }，返回带耗时的成功结果或含可用行列位置的错误。
 */
export function createTaskHandler() {
  let lastData;
  let lastSource = null;
  let lastNumberLiterals = null;
  let document = null;
  let comparison = null;
  let snapshotSequence = 0;
  const treeTask = createTreeTasks();

  function taskError(code, message) {
    return Object.assign(new Error(message), { code });
  }

  function retainSearch(data, source, numberLiterals, enabled = true) {
    lastData = enabled ? data : undefined;
    lastNumberLiterals = enabled ? numberLiterals : null;
    lastSource = enabled && numberLiterals === null ? source : null;
  }

  function requireSnapshot(snapshot, id) {
    if (!snapshot || snapshot.id !== id) throw taskError('SNAPSHOT_UNAVAILABLE', 'JSON snapshot is no longer available');
    return snapshot;
  }

  function documentData(snapshot) {
    if (snapshot.numberLiterals === null) {
      snapshot.numberLiterals = collectNumberLiterals(snapshot.jsonSource ?? snapshot.source);
    }
    if (lastData === snapshot.data) {
      lastNumberLiterals = snapshot.numberLiterals;
      lastSource = null;
    }
    return { data: snapshot.data, numberLiterals: snapshot.numberLiterals };
  }

  function withInputSide(text, side, parse) {
    try {
      return parse();
    } catch (error) {
      if (error instanceof SyntaxError) Object.assign(error, { code: 'INVALID_JSON', side, source: text });
      throw error;
    }
  }

  function parseWithLenientFallback(text, strict, runFn) {
    try {
      return runFn(text, false);
    } catch (error) {
      if (strict || !(error instanceof SyntaxError)) throw error;
      const converted = convertLenientJson(text, { trackOffsets: false });
      return runFn(converted.text, true);
    }
  }

  function parseComparison(text, side, strict = false) {
    if (comparison && comparison.left.source === text && !(strict && comparison.left.lenient)) return comparison.left;
    if (comparison && comparison.right.source === text && !(strict && comparison.right.lenient)) return comparison.right;
    return withInputSide(text, side, () => parseWithLenientFallback(
      text,
      strict,
      (jsonSource, lenient) => ({ source: text, jsonSource, lenient, ...parseJsonPreservingNumberLiterals(jsonSource) }),
    ));
  }

  function runAction({ action, text, indent, ...options }) {
    switch (action) {
      case 'clear':
        retainSearch(undefined, null, null, false);
        document = null;
        comparison = null;
        return {};
      case 'format': {
        const retainSnapshot = Boolean(options.retainSnapshot);
        const retainSearchFlag = options.retainSearch !== false;
        const needData = retainSnapshot || retainSearchFlag;
        const strict = options.strict === true;
        const cached = document?.source === text && !(strict && document.lenient) ? document : null;
        const { formatted, jsonSource, lenient } = cached
          ? {
              formatted: formatJson(cached.jsonSource ?? text, {
                indent,
                includeData: needData,
                includeNumberLiterals: options.includeNumberLiterals === true,
                parsed: cached,
              }),
              jsonSource: cached.jsonSource ?? text,
              lenient: Boolean(cached.lenient),
            }
          : parseWithLenientFallback(text, strict, (candidate, usedLenient) => ({
              formatted: formatJson(candidate, {
                indent,
                includeData: needData,
                includeNumberLiterals: options.includeNumberLiterals === true,
              }),
              jsonSource: candidate,
              lenient: usedLenient,
            }));
        retainSearch(formatted.data, jsonSource, formatted.numberLiterals, retainSearchFlag);
        document = retainSnapshot ? {
          id: ++snapshotSequence, source: text, jsonSource, output: formatted.text,
          data: formatted.data, numberLiterals: formatted.numberLiterals, lenient,
        } : null;
        const result = { text: formatted.text, lenient };
        if (document) result.snapshotId = document.id;
        return result;
      }
      case 'minify': {
        const retainSearchFlag = options.retainSearch !== false;
        const { formatted, jsonSource, lenient } = parseWithLenientFallback(
          text,
          options.strict === true,
          (candidate, usedLenient) => ({
            formatted: formatJson(candidate, { indent: null, includeData: retainSearchFlag }),
            jsonSource: candidate,
            lenient: usedLenient,
          }),
        );
        retainSearch(formatted.data, jsonSource, formatted.numberLiterals, retainSearchFlag);
        document = null;
        return { text: formatted.text, lenient };
      }
      case 'parse': {
        const strict = options.strict === true;
        const cachedBySource = document && document.source === text && !(strict && document.lenient);
        const cachedByOutput = !cachedBySource && document && document.output !== undefined && document.output === text;
        const cached = cachedBySource || cachedByOutput;
        const parsed = cached
          ? { ...documentData(document), jsonSource: document.jsonSource ?? text, lenient: cachedBySource ? Boolean(document.lenient) : false }
          : parseWithLenientFallback(text, strict, (candidate, usedLenient) => ({
              ...parseJsonPreservingNumberLiterals(candidate),
              jsonSource: candidate,
              lenient: usedLenient,
            }));
        retainSearch(parsed.data, parsed.jsonSource, parsed.numberLiterals, options.retainSearch !== false);
        if (options.retainSnapshot) {
          if (!cached) {
            document = {
              id: ++snapshotSequence,
              source: text,
              jsonSource: parsed.jsonSource,
              data: parsed.data,
              numberLiterals: parsed.numberLiterals,
              lenient: parsed.lenient,
            };
          }
          return { snapshotId: document.id, lenient: parsed.lenient };
        }
        document = null;
        return { lenient: parsed.lenient };
      }
      case 'comparisonPair': {
        const snapshot = requireSnapshot(comparison, options.snapshotId);
        if (options.side !== 'left' && options.side !== 'right') throw taskError('TASK_FAILED', 'Invalid tree side');
        if (options.path === options.knownAncestor) return { allowed: true };
        let value = snapshot[options.side].data;
        let offset = 0;
        // A recorded move proves its full path. Below it, only an actual
        // keyed array with omitted mappings makes an implicit index unsafe.
        for (const segment of options.path.slice(1).split('/')) {
          if (offset >= options.knownAncestor.length && snapshot.truncatedArrays?.has(value)) return { allowed: false };
          offset += segment.length + 1;
          value = value?.[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
        }
        return { allowed: true };
      }
      case 'tree': {
        if (options.kind === 'comparison') {
          const snapshot = requireSnapshot(comparison, options.snapshotId);
          if (options.side !== 'left' && options.side !== 'right') throw taskError('TASK_FAILED', 'Invalid tree side');
          return treeTask(snapshot, snapshot[options.side], options);
        }
        const snapshot = requireSnapshot(document, options.snapshotId);
        return treeTask(snapshot, documentData(snapshot), options);
      }
      case 'escape':
        return { text: escapeJsonString(text) };
      case 'unescape':
        return { text: unescapeJsonString(text) };
      case 'toYaml': {
        const { data, numberLiterals, lenient } = parseWithLenientFallback(
          text,
          options.strict === true,
          (candidate, usedLenient) => ({
            ...parseJsonPreservingNumberLiterals(candidate),
            lenient: usedLenient,
          }),
        );
        retainSearch(undefined, null, null, false);
        document = null;
        return { text: emitYaml(data, { numberLiterals }), lenient };
      }
      case 'fromYaml': {
        retainSearch(undefined, null, null, false);
        document = null;
        return yamlToJson(text, { indent });
      }
      case 'search':
        if (lastData === undefined) throw taskError('SEARCH_NOT_READY', 'Parse JSON before searching');
        if (lastNumberLiterals === null) {
          lastNumberLiterals = collectNumberLiterals(lastSource);
          lastSource = null;
        }
        return searchData(lastData, text, lastNumberLiterals);
      case 'diff': {
        const strict = options.strict === true;
        const left = parseComparison(text, 'left', strict);
        const right = options.text2 === text ? left : parseComparison(options.text2, 'right', strict);
        const truncatedArrays = new WeakSet();
        const result = diffData(left.data, right.data, {
          ...options,
          onTruncatedArray: (array) => truncatedArrays.add(array),
          leftNumberLiterals: left.numberLiterals,
          rightNumberLiterals: right.numberLiterals,
        });
        result.lenient = Boolean(left.lenient || right.lenient);
        result.leftLenient = Boolean(left.lenient);
        result.rightLenient = Boolean(right.lenient);
        const snapshot = { id: ++snapshotSequence, left, right, diffs: result.diffs, truncatedArrays, textDiff: null };
        comparison = options.retainSnapshot ? snapshot : null;
        if (comparison) result.snapshotId = comparison.id;
        return result;
      }
      case 'textDiff': {
        const indexOptions = options.includeTextIndex
          ? { includeTextIndex: true, textIndexThreshold: TEXT_INDEX_THRESHOLD }
          : undefined;
        if (options.snapshotId === undefined) {
          const strict = options.strict === true;
          const left = withInputSide(text, 'left', () => parseWithLenientFallback(
            text, strict, (candidate) => formatJson(candidate, { indent, includeData: false }).text,
          ));
          const right = text === options.text2 ? left
            : withInputSide(options.text2, 'right', () => parseWithLenientFallback(
              options.text2, strict, (candidate) => formatJson(candidate, { indent, includeData: false }).text,
            ));
          return diffFormattedText(left, right, indexOptions);
        }
        const snapshot = requireSnapshot(comparison, options.snapshotId);
        if (!snapshot.textDiff || snapshot.indent !== indent) {
          const left = formatJson(snapshot.left.jsonSource ?? snapshot.left.source, { indent, parsed: snapshot.left }).text;
          const right = snapshot.left === snapshot.right ? left
            : formatJson(snapshot.right.jsonSource ?? snapshot.right.source, { indent, parsed: snapshot.right }).text;
          snapshot.textDiff = diffFormattedText(left, right, indexOptions);
          snapshot.indent = indent;
        }
        return snapshot.textDiff;
      }
      default:
        throw taskError('UNKNOWN_ACTION', 'Unknown action: ' + action);
    }
  }

  return function handleTask(request) {
    const started = Date.now();
    try {
      const result = runAction(request);
      // A million-line output must not build its offsets in the UI message
      // callback. Keep the index cloneable; no strings or functions per line.
      if (request.includeTextIndex) {
        if (result.text?.length > TEXT_INDEX_THRESHOLD) result.lineIndex ||= createTextLineIndex(result.text);
        else if (request.action === 'parse' && request.text?.length > TEXT_INDEX_THRESHOLD) {
          result.lineIndex ||= createTextLineIndex(request.text);
        }
        if (result.aText?.length > TEXT_INDEX_THRESHOLD) result.aLineIndex ||= createTextLineIndex(result.aText);
        if (result.bText?.length > TEXT_INDEX_THRESHOLD) {
          result.bLineIndex ||= result.aText === result.bText ? result.aLineIndex : createTextLineIndex(result.bText);
        }
      }
      return { id: request.id, ok: true, result, duration: Date.now() - started };
    } catch (error) {
      const code = error.code || (error instanceof SyntaxError ? 'INVALID_JSON' : 'TASK_FAILED');
      const location = typeof error.position === 'number'
        ? { position: error.position, line: error.line, column: error.column }
        : code === 'INVALID_JSON' || code === 'INVALID_ESCAPE'
          ? parseErrorLocation(error.message, error.source ?? request.text)
          : { position: null, line: null, column: null };
      return {
        id: request.id,
        ok: false,
        error: error.message,
        code,
        ...(error.side ? { side: error.side } : {}),
        ...location,
        duration: Date.now() - started,
      };
    }
  };
}
