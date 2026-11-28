export const AUTO_FORMAT_ORIGINS = ['http://*/*', 'https://*/*', 'file:///*'];
export const PLAIN_TEXT_STORAGE_KEY = 'formatPlainText';
const AUTO_FORMAT_SCRIPT_ID = 'json-toolbox-auto-format';

async function getGrantedOrigins() {
  if (typeof chrome === 'undefined' || !chrome.permissions) return [];
  if (typeof chrome.permissions.getAll === 'function') {
    const all = await chrome.permissions.getAll();
    const granted = new Set(all?.origins || []);
    return AUTO_FORMAT_ORIGINS.filter((origin) => granted.has(origin));
  }
  if (typeof chrome.permissions.contains === 'function') {
    const matched = [];
    for (const origin of AUTO_FORMAT_ORIGINS) {
      if (await chrome.permissions.contains({ origins: [origin] })) matched.push(origin);
    }
    return matched;
  }
  return [];
}

async function notifyBackgroundSync() {
  try {
    await chrome.runtime?.sendMessage?.({ type: 'SYNC_AUTO_FORMAT' });
  } catch {
    // Background worker listeners will reconcile on startup or permission events.
  }
}

function checkFileSchemeAccess() {
  return new Promise((resolve) => {
    try {
      if (typeof chrome !== 'undefined' && chrome.extension?.isAllowedFileSchemeAccess) {
        chrome.extension.isAllowedFileSchemeAccess((allowed) => resolve(Boolean(allowed)));
      } else {
        resolve(true);
      }
    } catch {
      resolve(true);
    }
  });
}

export function initAutoFormatSettings() {
  const autoToggle = document.getElementById('auto-format-pages');
  const plainToggle = document.getElementById('auto-format-plain-text');
  const subEl = document.getElementById('auto-format-sub');
  const fileHintEl = document.getElementById('file-access-hint');
  if (!autoToggle || !plainToggle || !subEl) return null;

  let enabled = false;
  let plainText = false;
  let busy = false;

  function render() {
    autoToggle.setAttribute('aria-checked', String(enabled));
    plainToggle.setAttribute('aria-checked', String(plainText));
    subEl.hidden = !enabled;
  }

  async function refresh() {
    let granted = [];
    try {
      granted = await getGrantedOrigins();
      enabled = granted.length > 0;
    } catch {
      enabled = false;
    }
    if (typeof chrome === 'undefined' || !chrome.permissions) {
      enabled = false;
      plainText = false;
      if (fileHintEl) fileHintEl.hidden = true;
      render();
      return;
    }
    try {
      const stored = await chrome.storage?.local?.get?.(PLAIN_TEXT_STORAGE_KEY);
      plainText = Boolean(stored?.[PLAIN_TEXT_STORAGE_KEY]);
    } catch {
      plainText = false;
    }
    if (fileHintEl) {
      if (enabled && granted.includes('file:///*')) {
        const fileAllowed = await checkFileSchemeAccess();
        fileHintEl.hidden = fileAllowed;
      } else {
        fileHintEl.hidden = true;
      }
    }
    render();
  }

  autoToggle.addEventListener('click', () => {
    if (busy || typeof chrome === 'undefined' || !chrome.permissions) return;
    busy = true;
    const turningOn = !enabled;
    Promise.resolve((async () => {
      if (turningOn) {
        const result = await chrome.permissions.request({ origins: AUTO_FORMAT_ORIGINS });
        enabled = Boolean(result);
        if (enabled) await notifyBackgroundSync();
      } else {
        const granted = await getGrantedOrigins();
        const origins = granted.length ? granted : AUTO_FORMAT_ORIGINS;
        const result = await chrome.permissions.remove({ origins });
        if (result && chrome.scripting?.unregisterContentScripts) {
          try {
            await chrome.scripting.unregisterContentScripts({ ids: [AUTO_FORMAT_SCRIPT_ID] });
          } catch {
            // Ignore when script was not registered.
          }
        }
        if (result !== false) await notifyBackgroundSync();
      }
    })()).then(async () => {
      await refresh();
    }, () => {
      render();
    }).finally(() => {
      busy = false;
    });
  });

  plainToggle.addEventListener('click', async () => {
    plainText = !plainText;
    render();
    try {
      await chrome.storage?.local?.set?.({ [PLAIN_TEXT_STORAGE_KEY]: plainText });
    } catch {
      // Keep UI responsive even if storage write fails.
    }
  });

  if (typeof chrome !== 'undefined') {
    chrome.permissions?.onAdded?.addListener(() => { void refresh(); });
    chrome.permissions?.onRemoved?.addListener(() => { void refresh(); });
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area === 'local' && Object.hasOwn(changes, PLAIN_TEXT_STORAGE_KEY)) {
        plainText = Boolean(changes[PLAIN_TEXT_STORAGE_KEY].newValue);
        render();
      }
    });
  }

  void refresh();
  return { refresh };
}
