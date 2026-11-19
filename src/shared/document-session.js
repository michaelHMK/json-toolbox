import { createTaskRunner } from './worker-client.js';
import { cancelledResponse, createSessionGuard } from './session-guard.js';

/** Owns the displayed document and its Worker cache independently of input edits.
 * Cancellation invalidates pending work, but only clear or a successful replacement
 * retires the displayed document. Handles never expose Worker snapshot identifiers.
 * format/parse optionally publish their initial result through onResult before
 * resolving; apply guards subsequent asynchronous UI effects. Failures remain
 * task responses, while superseded operations return cancelled without publishing.
 */
export function createDocumentSession({
  createRunner = createTaskRunner,
  onBusyChange = () => {},
  onReset = () => {},
} = {}) {
  const guard = createSessionGuard();
  let formatting = null;
  let displayed = null;
  let parsing = null;
  let searchVersion = 0;
  const runTask = createRunner({
    serialize: true,
    onBusyChange,
    onReset() {
      displayed?.reset();
      formatting = null;
      // Preserve the generation so WORKER_FAILED reaches the caller as an error.
      onReset();
    },
  });

  function reply(response, version, record) {
    if (!guard.isCurrent(version)) return cancelledResponse();
    const result = response.result && { ...response.result };
    if (result) delete result.snapshotId;
    const value = { ...response, ...(result ? { result } : {}), ...(response.ok ? { document: record.handle } : {}) };
    return guard.bind(value, version, { record });
  }

  function apply(response, callback) {
    const scope = guard.meta(response);
    if (!scope || response.cancelled || !guard.isCurrent(scope.version) || scope.record !== displayed
        || formatting !== null || parsing !== null
        || (scope.search !== undefined && scope.search !== searchVersion)) return false;
    callback(response);
    return true;
  }

  function createDocument(source, remote, result, searchReady) {
    let snapshotId = result.snapshotId ?? null;
    let data = result.data;
    let numberLiterals = result.numberLiterals || null;
    let recovery = null;
    const record = {
      source,
      setRemote(value) { remote = value; if (remote) data = undefined; },
      reset() { snapshotId = null; searchReady = false; recovery = null; },
      invalidate() { recovery = null; },
    };
    const current = (version) => guard.isCurrent(version) && displayed === record && formatting === null && parsing === null;

    // Both tree windows and search share recovery of this displayed source, not
    // the editable input. A superseded recovery must not publish its snapshot.
    function restore({ requireData = false, requireSearch = false } = {}) {
      const version = guard.generation;
      if (!current(version)) return Promise.resolve(cancelledResponse());
      if ((!requireData || data !== undefined || remote) && (!requireSearch || searchReady) && snapshotId !== null) {
        return Promise.resolve({ ok: true, result: { data, numberLiterals } });
      }
      if (recovery?.version === version) return recovery.promise;
      const request = { version, promise: null };
      request.promise = (async () => {
        const response = snapshotId !== null && !requireSearch
          ? await runTask('parseSnapshot', { snapshotId, includeData: !remote })
          : await runTask('parse', { text: source, retainSnapshot: true, includeData: !remote });
        if (!current(version)) return cancelledResponse();
        if (response.ok) {
          snapshotId = response.result.snapshotId ?? snapshotId;
          if (response.result.data !== undefined) data = response.result.data;
          if (response.result.numberLiterals !== undefined) numberLiterals = response.result.numberLiterals;
          searchReady = true;
        }
        return response;
      })().finally(() => { if (recovery === request) recovery = null; });
      recovery = request;
      return request.promise;
    }

    record.handle = {
      get remote() { return remote; },
      get data() { return data; },
      get numberLiterals() { return numberLiterals; },
      get ready() { return data !== undefined || (remote && snapshotId !== null); },
      async ensureData() {
        const version = guard.generation;
        if (!current(version)) return cancelledResponse();
        const response = data !== undefined
          ? { ok: true, result: { data, numberLiterals } }
          : await restore({ requireData: true });
        if (!current(version)) return cancelledResponse();
        return reply(response.ok ? { ...response, result: { data, numberLiterals } } : response, version, record);
      },
      async search(query) {
        const version = guard.generation;
        const search = ++searchVersion;
        const active = () => current(version) && search === searchVersion;
        const searchReply = (response) => {
          const value = reply(response, version, record);
          guard.meta(value).search = search;
          return value;
        };
        if (!active()) return cancelledResponse();
        if (!query) return searchReply({ ok: true, result: { highlights: [], forceExpand: [], matchCount: 0, truncated: false } });
        if (!searchReady) {
          const restored = await restore({ requireSearch: true });
          if (!active()) return cancelledResponse();
          if (!restored.ok) return searchReply(restored);
        }
        const response = await runTask('search', { text: query }, { key: 'search' });
        if (!active()) return cancelledResponse();
        return searchReply(response);
      },
      async requestTree(payload) {
        const version = guard.generation;
        if (!current(version)) return cancelledResponse();
        const restored = await restore();
        if (!current(version)) return cancelledResponse();
        if (!restored.ok) return reply(restored, version, record);
        const response = await runTask('tree', { ...payload, kind: 'document', snapshotId });
        if (!current(version)) return cancelledResponse();
        return reply(response, version, record);
      },
    };
    return record;
  }

  function cancel(options = {}) {
    const replacing = formatting !== null || parsing !== null;
    guard.advance();
    searchVersion++;
    formatting = null;
    parsing = null;
    if (replacing) displayed?.reset();
    else displayed?.invalidate();
    return runTask.cancel(options);
  }

  return {
    get pending() { return formatting !== null; },
    async format(text, { indent = '2', remote = false, tree = false } = {}, onResult) {
      cancel({ onlyIfBusy: true });
      const version = guard.generation;
      const request = {};
      formatting = request;
      const retainDocument = tree || !remote;
      const response = await runTask('format', {
        text, indent, includeData: tree && !remote, includeNumberLiterals: tree,
        includeTextIndex: true, retainSnapshot: retainDocument, retainSearch: retainDocument,
      }, { key: 'format' });
      if (formatting === request) formatting = null;
      if (!guard.isCurrent(version) || response.cancelled) return cancelledResponse();
      if (response.ok) displayed = createDocument(response.result.text, remote, response.result, retainDocument);
      const value = reply(response, version, displayed);
      // Publish the handle and its initial UI state in the same continuation.
      // Later asynchronous view work can still use apply() to reject stale work.
      if (onResult) apply(value, onResult);
      return value;
    },
    async parse(text, { remote = false } = {}, onResult) {
      if (formatting !== null) return cancelledResponse();
      if (displayed?.source === text) {
        displayed.setRemote(remote);
        const response = await displayed.handle.ensureData();
        if (onResult) apply(response, onResult);
        return response;
      }
      const version = guard.generation;
      if (!parsing || parsing.source !== text || parsing.version !== version) {
        const request = { source: text, version, promise: null, callbacks: [] };
        request.promise = (async () => {
          const response = await runTask('parse', { text, retainSnapshot: true, includeData: !remote });
          if (!guard.isCurrent(version) || formatting !== null || parsing !== request) return cancelledResponse();
          parsing = null;
          if (response.ok) displayed = createDocument(text, remote, response.result, true);
          const value = reply(response, version, displayed);
          for (const callback of request.callbacks) apply(value, callback);
          return value;
        })().finally(() => { if (parsing === request) parsing = null; });
        parsing = request;
      }
      if (onResult) parsing.callbacks.push(onResult);
      return parsing.promise;
    },
    cancel,
    clear() {
      guard.advance();
      searchVersion++;
      formatting = null;
      parsing = null;
      displayed = null;
      void runTask('clear', {}, { discardQueued: true });
    },
    invalidateSearch() { searchVersion++; },
    defer: guard.defer,
    apply,
  };
}
