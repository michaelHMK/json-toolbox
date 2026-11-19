export const cancelledResponse = () => ({ ok: false, cancelled: true });

// Shared concurrency guard: monotonic generation counter, WeakMap response
// ownership metadata, and generation-scoped defer() for page/session layers.
export function createSessionGuard() {
  let generation = 0;
  const responses = new WeakMap();

  return {
    get generation() { return generation; },
    advance() { return ++generation; },
    isCurrent(version) { return version === generation; },
    bind(response, version, meta = {}) {
      responses.set(response, { version, ...meta });
      return response;
    },
    meta(response) { return responses.get(response); },
    defer(callback) {
      const version = generation;
      return setTimeout(() => { if (version === generation) callback(); }, 0);
    },
  };
}
