// Loaded synchronously before CSS so a saved sidebar state is applied before first paint.
(() => {
  const storageKey = 'json-toolbox.sidebar';
  const states = new Set(['expanded', 'collapsed']);
  let storage;
  let savedState;
  try {
    storage = window.localStorage;
    savedState = storage.getItem(storageKey);
  } catch {
    // Restricted storage must not prevent toggling the sidebar.
  }

  function message(key, fallback) {
    try {
      if (typeof chrome !== 'undefined' && chrome.i18n?.getMessage) {
        return chrome.i18n.getMessage(key) || fallback;
      }
    } catch {
      // Ignore unavailable extension i18n APIs and keep fallback labels.
    }
    return fallback;
  }

  function applySidebar(value) {
    const state = states.has(value) ? value : 'expanded';
    document.documentElement.dataset.sidebar = state;
    const collapsed = state === 'collapsed';
    const button = document.querySelector('#sidebar-toggle');
    if (button) {
      const labelKey = collapsed ? 'sidebarExpand' : 'sidebarCollapse';
      const titleKey = collapsed ? 'sidebarExpandTitle' : 'sidebarCollapseTitle';
      const labelFallback = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
      const titleFallback = collapsed ? 'Expand sidebar (Cmd/Ctrl + B)' : 'Collapse sidebar (Cmd/Ctrl + B)';
      button.setAttribute('aria-expanded', String(!collapsed));
      button.dataset.i18nTitle = titleKey;
      button.title = message(titleKey, titleFallback);
      const label = button.querySelector('.sidebar-toggle-label');
      if (label) {
        label.dataset.i18n = labelKey;
        label.textContent = message(labelKey, labelFallback);
      }
    }
    return state;
  }

  applySidebar(savedState);

  function closeThemeMenu() {
    const menu = document.querySelector('#theme-switch');
    const trigger = document.querySelector('#theme-trigger');
    if (menu && !menu.hidden) {
      menu.hidden = true;
      trigger?.setAttribute('aria-expanded', 'false');
    }
  }

  function toggleSidebar() {
    closeThemeMenu();
    const next = document.documentElement.dataset.sidebar === 'collapsed' ? 'expanded' : 'collapsed';
    const state = applySidebar(next);
    try {
      storage?.setItem(storageKey, state);
    } catch {
      // Keep the current page usable even if saving the preference is blocked.
    }
  }

  // Page modules render the shared navigation before DOMContentLoaded.
  document.addEventListener('DOMContentLoaded', () => {
    applySidebar(document.documentElement.dataset.sidebar);
    const button = document.querySelector('#sidebar-toggle');
    button?.addEventListener('click', toggleSidebar);
    document.addEventListener('keydown', (event) => {
      if (event.defaultPrevented || event.isComposing || event.repeat || event.altKey || event.shiftKey) return;
      if (!((event.metaKey || event.ctrlKey) && !(event.metaKey && event.ctrlKey))) return;
      if (event.key?.toLowerCase() !== 'b') return;
      if (window.matchMedia?.('(max-width: 780px)')?.matches) return;
      event.preventDefault();
      toggleSidebar();
    });
  }, { once: true });

  window.addEventListener('storage', (event) => {
    if (event.storageArea !== storage) return;
    if (event.key === storageKey || event.key === null) applySidebar(event.newValue);
  });
})();
