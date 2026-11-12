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
    const selected = document.querySelector(`#theme-switch [data-theme-option="${theme}"]`);
    for (const button of document.querySelectorAll('#theme-switch [data-theme-option]')) {
      button.setAttribute('aria-pressed', String(button === selected));
    }
    const current = document.querySelector('#theme-current');
    const label = selected?.querySelector('.theme-option-name');
    if (current && label) {
      current.dataset.i18n = selected.dataset.themeLabel;
      current.textContent = label.textContent;
    }
    return theme;
  }

  applyTheme(savedTheme);

  // Page modules render the shared navigation before DOMContentLoaded.
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(document.documentElement.dataset.theme);
    const trigger = document.querySelector('#theme-trigger');
    const menu = document.querySelector('#theme-switch');
    if (!trigger || !menu) return;
    const options = [...document.querySelectorAll('#theme-switch [data-theme-option]')];
    const setOpen = (open, restoreFocus = false) => {
      menu.hidden = !open;
      trigger.setAttribute('aria-expanded', String(open));
      if (open) (options.find(button => button.getAttribute('aria-pressed') === 'true') || options[0])?.focus();
      else if (restoreFocus) trigger.focus();
    };
    trigger.addEventListener('click', () => setOpen(menu.hidden));
    for (const button of options) {
      button.addEventListener('click', () => {
        const theme = applyTheme(button.dataset.themeOption);
        try {
          storage?.setItem(storageKey, theme);
        } catch {
          // Keep the current page usable even if saving the preference is blocked.
        }
        setOpen(false, true);
      });
    }
    document.addEventListener('click', event => {
      if (!menu.hidden && !event.target.closest('.theme-picker')) setOpen(false);
    });
    document.addEventListener('focusin', event => {
      if (!menu.hidden && !event.target.closest('.theme-picker')) setOpen(false);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !menu.hidden) {
        event.preventDefault();
        setOpen(false, true);
      }
    });
  }, { once: true });

  window.addEventListener('storage', (event) => {
    if (event.storageArea !== storage) return;
    if (event.key === storageKey || event.key === null) applyTheme(event.newValue);
  });
})();
