import { createTaskRunner } from '../../src/shared/worker-client.js';
import { createTaskHandler } from '../../src/worker/tasks.js';

// Exercise session recovery against real Worker task/cache behavior while
// controlling the response boundary without a browser or timing assumptions.
export function createSessionWorker() {
  const workers = [];
  const held = new Set();
  const createRunner = (options) => createTaskRunner({
    ...options,
    createWorker() {
      const handle = createTaskHandler();
      const worker = {
        requests: [],
        terminated: false,
        terminate() { this.terminated = true; },
        postMessage(request) {
          this.requests.push(request);
          if (!held.has(request.action)) this.complete(request);
        },
        complete(request) {
          queueMicrotask(() => {
            if (!this.terminated) this.onmessage({ data: structuredClone(handle(structuredClone(request))) });
          });
        },
        crash() { this.onerror({ message: 'test worker crash', preventDefault() {} }); },
      };
      workers.push(worker);
      return worker;
    },
  });
  return { createRunner, workers, held };
}
