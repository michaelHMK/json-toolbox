import { createTaskRunner } from './worker-client.js';

const cancelled = () => ({ ok: false, cancelled: true });
const dataKeys = ['leftData', 'rightData', 'leftNumberLiterals', 'rightNumberLiterals'];

// A displayed comparison survives input edits and Worker replacement. Its
// handle owns the source and snapshot; UI state never needs a Worker identity.
// compare optionally publishes through onResult before resolving; apply guards
// later UI effects. Cancelled/stale operations never publish; failures do.
export function createComparisonSession({ createRunner = createTaskRunner, onBusyChange } = {}) {
  let generation = 0;
  let comparing = null;
  let current = null;
  const responses = new WeakMap();
  const run = createRunner({
    serialize: true,
    onBusyChange,
    onReset() { current?.reset(); },
  });

  function remember(response, version, comparison = null) {
    responses.set(response, { version, comparison });
    return response;
  }

  function isCurrent(comparison, version) {
    return version === generation && comparison === current && comparing === null;
  }

  function makeComparison(options, initial) {
    let snapshotId = initial.snapshotId;
    const { snapshotId: _, ...result } = initial;
    let textResult = null;
    let dataRequest = null;
    let textRequest = null;
    const data = {};
    for (const key of dataKeys) {
      if (initial[key] !== undefined) data[key] = initial[key];
    }
    const comparison = {
      reset() {
        snapshotId = undefined;
        this.invalidate();
      },
      invalidate() {
        dataRequest = null;
        textRequest = null;
      },
      handle: null,
      result,
    };

    async function ensureData(requireSnapshot = false) {
      const version = generation;
      if (!isCurrent(comparison, version)) return cancelled();
      const hasData = options.remote || data.leftData !== undefined;
      const hasSnapshot = snapshotId !== undefined;
      if (hasData && (!(options.remote || requireSnapshot) || hasSnapshot)) {
        return remember({ ok: true, result: data }, version, comparison);
      }
      if (!dataRequest) {
        const request = { promise: null };
        request.promise = (async () => {
          const response = hasSnapshot
            ? await run('comparisonData', { snapshotId, includeData: !options.remote })
            : await run('diff', {
              text: options.text, text2: options.text2,
              keyField: options.keyField, ignorePaths: options.ignorePaths,
              retainSnapshot: true, includeData: !options.remote,
            });
          if (!isCurrent(comparison, version)) return cancelled();
          if (!response.ok) return remember(response, version, comparison);
          if (response.result.snapshotId !== undefined) snapshotId = response.result.snapshotId;
          // Rehydration must preserve the original keyed/filtered diff summary.
          for (const key of dataKeys) {
            if (response.result[key] !== undefined) data[key] = result[key] = response.result[key];
          }
          return remember({ ...response, result: data }, version, comparison);
        })().finally(() => {
          if (dataRequest === request) dataRequest = null;
        });
        dataRequest = request;
      }
      return dataRequest.promise;
    }

    async function textDiff() {
      const version = generation;
      if (!isCurrent(comparison, version)) return cancelled();
      if (textResult) return remember({ ok: true, result: textResult }, version, comparison);
      if (!textRequest) {
        const request = { promise: null };
        request.promise = (async () => {
          const response = await run('textDiff', {
            ...(snapshotId === undefined
              ? { text: options.text, text2: options.text2 }
              : { snapshotId }),
            indent: '2', includeTextIndex: true,
          });
          if (!isCurrent(comparison, version)) return cancelled();
          if (response.ok) textResult = response.result;
          return remember(response, version, comparison);
        })().finally(() => {
          if (textRequest === request) textRequest = null;
        });
        textRequest = request;
      }
      return textRequest.promise;
    }

    async function requestTree(side, payload) {
      const version = generation;
      const ready = await ensureData(true);
      if (!isCurrent(comparison, version)) return cancelled();
      if (!ready.ok) return ready;
      const response = await run('tree', { ...payload, kind: 'comparison', side, snapshotId });
      if (!isCurrent(comparison, version)) return cancelled();
      return remember(response, version, comparison);
    }

    comparison.handle = { ensureData: () => ensureData(), textDiff, requestTree };
    return comparison;
  }

  function cancel({ onlyIfBusy = false } = {}) {
    const replacing = comparing !== null;
    generation++;
    comparing = null;
    // Transport may already be idle while a completed replacement response is
    // awaiting this session's continuation. Its snapshot has replaced the old
    // one even if onlyIfBusy consequently keeps the Worker alive.
    if (replacing) current?.reset();
    else current?.invalidate();
    return run.cancel({ onlyIfBusy });
  }

  function apply(response, callback) {
    const context = responses.get(response);
    if (!context || response.cancelled || context.version !== generation
        || (context.comparison && !isCurrent(context.comparison, context.version))) return false;
    callback(response);
    return true;
  }

  async function compare({ text, text2, keyField = '', ignorePaths = [], remote = false, includeData = !remote }, onResult) {
    cancel({ onlyIfBusy: true });
    const version = generation;
    const operation = {};
    comparing = operation;
    const options = { text, text2, keyField, ignorePaths: [...ignorePaths], remote };
    const response = await run('diff', {
      text, text2, keyField, ignorePaths: options.ignorePaths,
      includeData: includeData && !remote, retainSnapshot: true,
    }, { key: 'diff' });
    if (version !== generation || comparing !== operation) return cancelled();
    comparing = null;
    let value;
    if (!response.ok) value = remember(response, version);
    else {
      current = makeComparison(options, response.result);
      value = remember({ ...response, result: current.result, comparison: current.handle }, version, current);
    }
    // Commit the displayed handle and its UI together, before yielding back to
    // the caller where cancellation could otherwise separate the two commits.
    if (onResult) apply(value, onResult);
    return value;
  }

  return {
    compare,
    cancel,
    clear() {
      generation++;
      comparing = null;
      current = null;
      void run('clear', {}, { discardQueued: true });
    },
    get pending() { return comparing !== null; },
    defer(callback) {
      const version = generation;
      return setTimeout(() => { if (version === generation) callback(); }, 0);
    },
    apply,
  };
}
