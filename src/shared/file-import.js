import { t } from './i18n.js';

export const MAX_FILE_SIZE = 50 * 1024 * 1024;

class FileImportError extends Error {
  constructor(key, substitutions = []) {
    super(key);
    this.key = key;
    this.substitutions = substitutions;
  }
}

export function formatFileSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Number((size / 1024).toFixed(1))} KiB`;
  return `${Number((size / (1024 * 1024)).toFixed(1))} MiB`;
}

export async function readJsonFile(file) {
  if (!file?.name || !/\.json$/i.test(file.name)) {
    throw new FileImportError('errFileType');
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new FileImportError('errFileTooLarge', [formatFileSize(MAX_FILE_SIZE)]);
  }
  if (file.size === 0) throw new FileImportError('errFileEmpty');

  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (error) {
    throw new FileImportError('errFileRead', [file.name, error?.message || String(error)]);
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new FileImportError('errFileEncoding');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) throw new FileImportError('errFileEmpty');
  return { name: file.name, size: file.size, text };
}

export function createFileImport({
  dropZone, fileInput, triggerEl, fileNameEl, dropHint,
  onImport, onError,
}) {
  const defaultButtonLabel = triggerEl.textContent;
  let sequence = 0;
  let dragDepth = 0;

  function setReading(reading) {
    triggerEl.disabled = reading;
    triggerEl.textContent = reading ? t('fileReading') : defaultButtonLabel;
    if (reading) triggerEl.setAttribute('aria-busy', 'true');
    else triggerEl.removeAttribute('aria-busy');
  }

  function setDragActive(active) {
    dropZone.classList.toggle('is-dragging', active);
    dropHint.hidden = !active;
  }

  function clearDrag() {
    dragDepth = 0;
    setDragActive(false);
  }

  function showFile({ name, size }) {
    const label = `${name} · ${formatFileSize(size)}`;
    fileNameEl.textContent = label;
    fileNameEl.title = label;
    fileNameEl.hidden = false;
  }

  function reportError(error, file) {
    if (error instanceof FileImportError) {
      onError(t(error.key, error.substitutions));
    } else {
      onError(t('errFileRead', [file.name, error?.message || String(error)]));
    }
  }

  async function importFile(file) {
    const version = ++sequence;
    setReading(true);
    let result;
    try {
      result = await readJsonFile(file);
    } catch (error) {
      if (version === sequence) {
        reportError(error, file);
        setReading(false);
      }
      return;
    }
    if (version !== sequence) return;
    showFile(result);
    try {
      onImport(result);
    } finally {
      if (version === sequence) setReading(false);
    }
  }

  function hasFiles(event) {
    return Array.from(event.dataTransfer?.types || []).includes('Files');
  }

  triggerEl.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) void importFile(file);
  });

  dropZone.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth++;
    setDragActive(true);
  });
  dropZone.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  });
  dropZone.addEventListener('dragleave', (event) => {
    if (dragDepth === 0) return;
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDragActive(false);
  });
  dropZone.addEventListener('drop', (event) => {
    const files = Array.from(event.dataTransfer?.files || []);
    if (!hasFiles(event) && files.length === 0) return;
    event.preventDefault();
    clearDrag();
    if (files.length === 0) return;
    if (files.length !== 1) {
      sequence++;
      setReading(false);
      onError(t('errFileMultiple'));
      return;
    }
    void importFile(files[0]);
  });

  return {
    reset() {
      sequence++;
      fileInput.value = '';
      fileNameEl.textContent = '';
      fileNameEl.title = '';
      fileNameEl.hidden = true;
      clearDrag();
      setReading(false);
    },
  };
}
