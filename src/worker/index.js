import { createTaskHandler } from './tasks.js';
import { postTaskResponse } from '../shared/worker-protocol.js';

const handleTask = createTaskHandler();
self.onmessage = (event) => postTaskResponse(
  event.data,
  handleTask,
  (response, transfer) => (transfer?.length ? self.postMessage(response, transfer) : self.postMessage(response)),
);
