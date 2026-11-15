import { createTaskResponseDecoder } from './worker-protocol.js';

/**
 * 每个页面拥有独立 Worker；请求按 id 配对，busy 持续到所有请求结束。
 * cancel/clear 立即终止正在执行的同步计算；下一次请求才创建新 Worker。
 * onReset 通知页面 Worker 内的搜索数据和快照已失效。
 */
export function createTaskRunner({
  onBusyChange = () => {},
  onReset = () => {},
  createWorker = () => new Worker(new URL('../worker/index.js', import.meta.url), { type: 'module' }),
  serialize = false,
} = {}) {
  let worker;
  let sequence = 0;
  const pending = new Map();
  const queued = [];
  let activeId = null;
  const decode = createTaskResponseDecoder();

  function send(request) {
    if (serialize) activeId = request.id;
    try {
      worker.postMessage(request);
    } catch (error) {
      finish({ id: request.id, ok: false, code: 'TASK_FAILED', error: error.message || String(error) });
    }
  }

  function pump() {
    if (!serialize || !worker || activeId !== null || !queued.length) return;
    send(queued.shift().request);
  }

  function finish(message) {
    const resolve = pending.get(message.id);
    if (!resolve) return;
    const response = decode(message);
    if (!response) return;
    pending.delete(message.id);
    if (message.id === activeId) activeId = null;
    onBusyChange(pending.size > 0);
    resolve(response);
    pump();
  }

  function reset(response) {
    const previous = worker;
    worker = undefined;
    previous?.terminate();
    queued.length = 0;
    activeId = null;
    const requests = [...pending];
    pending.clear();
    decode.clear();
    onReset();
    onBusyChange(false);
    for (const [id, resolve] of requests) resolve({ id, ok: false, ...response });
  }

  function ensureWorker() {
    if (worker) return;
    const current = createWorker();
    worker = current;
    current.onmessage = (event) => {
      if (worker === current) finish(event.data);
    };
    current.onerror = (event) => {
      event.preventDefault();
      if (worker === current) reset({ code: 'WORKER_FAILED', error: event.message || 'Worker error' });
    };
    current.onmessageerror = () => {
      if (worker === current) reset({ code: 'WORKER_FAILED', error: 'Worker message could not be read' });
    };
  }

  function runTask(action, payload = {}, { key, discardQueued = false } = {}) {
    const id = ++sequence;
    if (action === 'clear') {
      runTask.cancel();
      return Promise.resolve({ id, ok: true, result: {} });
    }
    try {
      ensureWorker();
    } catch (error) {
      reset({ code: 'WORKER_FAILED', error: error.message || String(error) });
      return Promise.resolve({ id, ok: false, code: 'WORKER_FAILED', error: error.message || String(error) });
    }
    return new Promise((resolve) => {
      pending.set(id, resolve);
      onBusyChange(true);
      const request = { ...payload, id, action };
      if (!serialize) {
        send(request);
        return;
      }
      // 尚未发送的过期输入无需再克隆、解析或计算。
      for (let i = queued.length - 1; i >= 0; i--) {
        if (!discardQueued && (key === undefined || queued[i].key !== key)) continue;
        const [{ request: cancelled }] = queued.splice(i, 1);
        const settle = pending.get(cancelled.id);
        pending.delete(cancelled.id);
        settle({ id: cancelled.id, ok: false, cancelled: true, error: 'Task superseded' });
      }
      queued.push({ request, key });
      pump();
    });
  }

  runTask.cancel = ({ onlyIfBusy = false } = {}) => {
    if (onlyIfBusy && pending.size === 0) return false;
    reset({ cancelled: true, error: 'Task cancelled' });
    return true;
  };
  return runTask;
}
