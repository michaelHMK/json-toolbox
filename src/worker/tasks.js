import { formatJson, parseJsonPreservingNumberLiterals, collectNumberLiterals } from '../core/json.js';
import { escapeJsonString, unescapeJsonString } from '../core/escape.js';
import { searchData } from '../core/search.js';
import { diffData } from '../core/structural-diff.js';
import { makeTextDiff, diffFormattedText } from '../core/text-diff.js';
import { parseErrorLocation } from '../core/parse-error.js';

/**
 * 一次 Worker 会话的任务入口。format/minify/parse 按需更新搜索数据；
 * retainSnapshot 显式保留当前文档/对比供视图切换复用；snapshotId 防止旧请求读到新数据。
 * retainSearch=false 释放搜索数据；includeData 只控制对象传输；clear 释放数据及快照。
 * 输入 { id, action, text, ... }，返回带耗时的成功结果或含可用行列位置的错误。
 */
export function createTaskHandler() {
  let lastData;
  let document = null;
  let comparison = null;
  let snapshotSequence = 0;

  function requireSnapshot(snapshot, id) {
    if (!snapshot || snapshot.id !== id) throw new Error('JSON snapshot is no longer available');
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

  function parseComparison(text, label) {
    if (comparison && comparison.left.source === text) return comparison.left;
    if (comparison && comparison.right.source === text) return comparison.right;
    try {
      return { source: text, ...parseJsonPreservingNumberLiterals(text) };
    } catch (error) {
      throw new Error(label + ' JSON 无效：' + error.message);
    }
  }

  function runAction({ action, text, indent, ...options }) {
    switch (action) {
      case 'clear':
        lastData = undefined;
        document = null;
        comparison = null;
        return {};
      case 'format': {
        const includeData = options.includeData !== false;
        const cached = document?.source === text ? document : null;
        const formatted = formatJson(text, { indent, includeNumberLiterals: includeData, parsed: cached });
        lastData = options.retainSearch === false ? undefined : formatted.data;
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
        lastData = options.retainSearch === false ? undefined : formatted.data;
        document = null;
        return { text: formatted.text };
      }
      case 'parse': {
        const cached = document && (document.source === text ||
          (document.output !== undefined && document.output === text));
        const parsed = cached ? documentData(document) : parseJsonPreservingNumberLiterals(text);
        lastData = parsed.data;
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
        if (lastData === undefined) throw new Error('请先解析 JSON');
        return searchData(lastData, text);
      case 'diff': {
        const left = parseComparison(text, '左侧');
        const right = options.text2 === text ? left : parseComparison(options.text2, '右侧');
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
        if (options.snapshotId === undefined) return makeTextDiff(text, options.text2, indent);
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
        throw new Error('未知操作: ' + action);
    }
  }

  return function handleTask(request) {
    const started = Date.now();
    try {
      const result = runAction(request);
      return { id: request.id, ok: true, result, duration: Date.now() - started };
    } catch (error) {
      return {
        id: request.id,
        ok: false,
        error: error.message,
        ...parseErrorLocation(error.message, request.text),
        duration: Date.now() - started,
      };
    }
  };
}
