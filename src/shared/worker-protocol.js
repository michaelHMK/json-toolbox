const CHUNK_NODES = 256;
const CHUNK_CHARACTERS = 64 * 1024;
const isContainer = (value) => value !== null && typeof value === 'object';

// V8 structured clone has a shallower stack limit than JSON.parse. Ordinary
// responses retain native cloning; a failed tree uses bounded shallow batches.
// The UI links each batch iteratively, without parsing the source a second time.
function postTreeChunks(response, postMessage) {
  const { data, leftData, rightData, ...metadata } = response.result;
  const roots = Object.hasOwn(response.result, 'data') ? { data } : { leftData, rightData };
  const seen = new WeakMap();
  let nextId = 0;
  let batch = [];
  let characters = 0;
  const flush = () => {
    if (!batch.length) return;
    postMessage({ id: response.id, treeChunk: batch });
    batch = [];
    characters = 0;
  };
  function append(parent, key, value) {
    const id = nextId++;
    const container = isContainer(value);
    const reference = container ? seen.get(value) : undefined;
    const kind = reference !== undefined ? 3 : Array.isArray(value) ? 1 : container ? 2 : 0;
    const payload = kind === 3 ? reference : kind === 1 ? value.length : kind === 0 ? value : undefined;
    const size = String(key).length + (typeof payload === 'string' ? payload.length : 0);
    if (batch.length && (batch.length >= CHUNK_NODES || characters + size > CHUNK_CHARACTERS)) flush();
    batch.push([parent, key, kind, payload]);
    characters += size;
    if (!container || reference !== undefined) return null;
    seen.set(value, id);
    return { value, id, keys: Array.isArray(value) ? null : Object.keys(value), next: 0 };
  }
  const stack = [append(-1, '', roots)];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const length = frame.keys ? frame.keys.length : frame.value.length;
    if (frame.next >= length) { stack.pop(); continue; }
    const key = frame.keys ? frame.keys[frame.next++] : frame.next++;
    const child = append(frame.id, key, frame.value[key]);
    if (child) stack.push(child);
  }
  flush();
  postMessage({ ...response, result: { ...metadata, streamedData: true } });
}

export function postTaskResponse(request, handleTask, postMessage) {
  const response = handleTask(request);
  try {
    postMessage(response);
  } catch (error) {
    const result = response.result;
    if (response.ok && result && (Object.hasOwn(result, 'data') || Object.hasOwn(result, 'leftData'))) {
      try {
        postTreeChunks(response, postMessage);
        return;
      } catch (fallbackError) {
        error = fallbackError;
      }
    }
    // Even a partial transfer must settle and release its accumulated nodes.
    postMessage({ id: request.id, ok: false, error: error.message || String(error), duration: response.duration });
  }
}

// Ordinary messages are already usable. Stateful tree batches are decoded by
// one decoder per Worker connection, so cancellation can release every node.
export const decodeTaskResponse = (response) => response;

export function createTaskResponseDecoder() {
  const transfers = new Map();
  function read(response) {
    if (response.treeChunk) {
      let nodes = transfers.get(response.id);
      if (!nodes) transfers.set(response.id, nodes = []);
      for (const [parent, key, kind, payload] of response.treeChunk) {
        const value = kind === 1 ? new Array(payload) : kind === 2 ? {} : kind === 3 ? nodes[payload] : payload;
        if (parent >= 0) {
          // JSON's __proto__ key is an own data property, not a setter.
          if (key === '__proto__') Object.defineProperty(nodes[parent], key, { value, writable: true, enumerable: true, configurable: true });
          else nodes[parent][key] = value;
        }
        nodes.push(value);
      }
      return null;
    }
    const nodes = transfers.get(response.id);
    transfers.delete(response.id);
    if (!response.ok || !response.result?.streamedData) return response;
    if (!nodes) return { id: response.id, ok: false, error: 'Incomplete tree transfer', duration: response.duration };
    const { streamedData, ...metadata } = response.result;
    return { ...response, result: { ...metadata, ...nodes[0] } };
  }
  function decode(response) {
    try { return read(response); }
    catch (error) {
      transfers.delete(response.id);
      return { id: response.id, ok: false, error: error.message || String(error), duration: response.duration };
    }
  }
  decode.clear = () => transfers.clear();
  return decode;
}
