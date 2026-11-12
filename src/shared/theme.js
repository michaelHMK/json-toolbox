// Loaded synchronously before CSS so a saved theme is applied before first paint.
(() => {
  const storageKey = 'json-toolbox.theme';
  const themes = new Set(['normal', 'comfort', 'dark']);
  let storage;
  let savedTheme;
  try {
    storage = window.localStorage;
    savedTheme = storage.getItem(storageKey);
  } catch {
    // Restricted storage must not prevent the tools or theme switch from working.
  }

  function applyTheme(value) {
    const theme = themes.has(value) ? value : 'normal';
    document.documentElement.dataset.theme = theme;
    for (const button of document.querySelectorAll('#theme-switch [data-theme-option]')) {
      button.setAttribute('aria-pressed', String(button.dataset.themeOption === theme));
    }
    return theme;
  }

  applyTheme(savedTheme);

  // Page modules render the shared navigation before DOMContentLoaded.
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(document.documentElement.dataset.theme);
    for (const button of document.querySelectorAll('#theme-switch [data-theme-option]')) {
      button.addEventListener('click', () => {
        const theme = applyTheme(button.dataset.themeOption);
        try {
          storage?.setItem(storageKey, theme);
        } catch {
          // Keep the current page usable even if saving the preference is blocked.
        }
      });
    }
  }, { once: true });

  window.addEventListener('storage', (event) => {
    if (event.storageArea !== storage) return;
    if (event.key === storageKey || event.key === null) applyTheme(event.newValue);
  });
})();
