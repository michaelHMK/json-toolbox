function transferableBuffers(request, response) {
  if (!response.ok || !response.result) return [];
  const { lineIndex, aLineIndex, bLineIndex } = response.result;
  const buffers = new Set();
  if (lineIndex?.starts?.buffer instanceof ArrayBuffer) buffers.add(lineIndex.starts.buffer);
  if (request.action === 'textDiff' && request.snapshotId === undefined) {
    if (aLineIndex?.starts?.buffer instanceof ArrayBuffer) buffers.add(aLineIndex.starts.buffer);
    if (bLineIndex?.starts?.buffer instanceof ArrayBuffer) buffers.add(bLineIndex.starts.buffer);
  }
  return [...buffers];
}

export function postTaskResponse(request, handleTask, postMessage) {
  const response = handleTask(request);
  const transfer = transferableBuffers(request, response);
  try {
    if (transfer.length) postMessage(response, transfer);
    else postMessage(response);
  } catch (error) {
    postMessage({
      id: request.id,
      ok: false,
      code: 'TASK_FAILED',
      error: error.message || String(error),
      duration: response.duration,
    });
  }
}
