import { formatJson, parseJsonPreservingNumberLiterals, collectNumberLiterals } from '../core/json.js';
import { escapeJsonString, unescapeJsonString } from '../core/escape.js';
import { searchData } from '../core/search.js';
import { diffData } from '../core/structural-diff.js';
import { diffFormattedText } from '../core/text-diff.js';
import { parseErrorLocation } from '../core/parse-error.js';

/**
 * 一次 Worker 会话的任务入口。format/minify/parse 按需更新搜索数据；
 * retainSnapshot 显式保留当前文档/对比供视图切换复用；snapshotId 防止旧请求读到新数据。
 * retainSearch=false 释放搜索数据；includeData 只控制对象传输；clear 释放数据及快照。
 * 输入 { id, action, text, ... }，返回带耗时的成功结果或含可用行列位置的错误。
 */
export function createTaskHandler() {
  let lastData;
  let lastSource = null;
  let lastNumberLiterals = null;
  let document = null;
  let comparison = null;
  let snapshotSequence = 0;

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
      snapshot.numberLiterals = collectNumberLiterals(snapshot.source);
    }
    return { data: snapshot.data, numberLiterals: snapshot.numberLiterals };
  }

  function comparisonData(snapshot) {
    return {
      leftData: snapshot.left.data,
      rightData: snapshot.right.data,
      leftNumberLiterals: snapshot.left.numberLiterals,
      rightNumberLiterals: snapshot.right.numberLiterals,
    };
  }

  function withInputSide(text, side, parse) {
    try {
      return parse();
    } catch (error) {
      if (error instanceof SyntaxError) Object.assign(error, { code: 'INVALID_JSON', side, source: text });
      throw error;
    }
  }

  function parseComparison(text, side) {
    if (comparison && comparison.left.source === text) return comparison.left;
    if (comparison && comparison.right.source === text) return comparison.right;
    return withInputSide(text, side, () => ({ source: text, ...parseJsonPreservingNumberLiterals(text) }));
  }

  function runAction({ action, text, indent, ...options }) {
    switch (action) {
      case 'clear':
        retainSearch(undefined, null, null, false);
        document = null;
        comparison = null;
        return {};
      case 'format': {
        const includeData = options.includeData !== false;
        const cached = document?.source === text ? document : null;
        const formatted = formatJson(text, { indent, includeNumberLiterals: includeData, parsed: cached });
        retainSearch(formatted.data, text, formatted.numberLiterals, options.retainSearch !== false);
        document = options.retainSnapshot ? {
          id: ++snapshotSequence, source: text, output: formatted.text,
          data: formatted.data, numberLiterals: formatted.numberLiterals,
        } : null;
        const result = includeData ? formatted : { text: formatted.text };
        if (document) result.snapshotId = document.id;
        return result;
      }
      case 'minify': {
        const formatted = formatJson(text, { indent: null });
        retainSearch(formatted.data, text, formatted.numberLiterals, options.retainSearch !== false);
        document = null;
        return { text: formatted.text };
      }
      case 'parse': {
        const cached = document && (document.source === text ||
          (document.output !== undefined && document.output === text));
        const parsed = cached ? documentData(document) : parseJsonPreservingNumberLiterals(text);
        retainSearch(parsed.data, text, parsed.numberLiterals, options.retainSearch !== false);
        if (options.retainSnapshot) {
          if (!cached) document = { id: ++snapshotSequence, source: text, ...parsed };
          return { ...parsed, snapshotId: document.id };
        }
        document = null;
        return parsed;
      }
      case 'parseSnapshot':
        return documentData(requireSnapshot(document, options.snapshotId));
      case 'comparisonData':
        return comparisonData(requireSnapshot(comparison, options.snapshotId));
      case 'snapshotText': {
        if (options.kind === 'document') {
          return { data: requireSnapshot(document, options.snapshotId).source };
        }
        const snapshot = requireSnapshot(comparison, options.snapshotId);
        return { leftData: snapshot.left.source, rightData: snapshot.right.source };
      }
      case 'escape':
        return { text: escapeJsonString(text) };
      case 'unescape':
        return { text: unescapeJsonString(text) };
      case 'search':
        if (lastData === undefined) throw taskError('SEARCH_NOT_READY', 'Parse JSON before searching');
        if (lastNumberLiterals === null) {
          lastNumberLiterals = collectNumberLiterals(lastSource);
          lastSource = null;
        }
        return searchData(lastData, text, lastNumberLiterals);
      case 'diff': {
        const left = parseComparison(text, 'left');
        const right = options.text2 === text ? left : parseComparison(options.text2, 'right');
        const result = diffData(left.data, right.data, {
          ...options,
          leftNumberLiterals: left.numberLiterals,
          rightNumberLiterals: right.numberLiterals,
        });
        const snapshot = { id: ++snapshotSequence, left, right, textDiff: null };
        if (options.includeData !== false) Object.assign(result, comparisonData(snapshot));
        comparison = options.retainSnapshot ? snapshot : null;
        if (comparison) result.snapshotId = comparison.id;
        return result;
      }
      case 'textDiff': {
        if (options.snapshotId === undefined) {
          const left = withInputSide(text, 'left', () => formatJson(text, { indent }).text);
          const right = text === options.text2 ? left
            : withInputSide(options.text2, 'right', () => formatJson(options.text2, { indent }).text);
          return diffFormattedText(left, right);
        }
        const snapshot = requireSnapshot(comparison, options.snapshotId);
        if (!snapshot.textDiff || snapshot.indent !== indent) {
          const left = formatJson(snapshot.left.source, { indent, parsed: snapshot.left }).text;
          const right = snapshot.left === snapshot.right ? left
            : formatJson(snapshot.right.source, { indent, parsed: snapshot.right }).text;
          snapshot.textDiff = diffFormattedText(left, right);
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
