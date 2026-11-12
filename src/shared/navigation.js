const navItems = [
  {
    id: 'format',
    href: 'formatter.html',
    label: 'navFormat',
    fallback: 'JSON Formatter',
    icon: '<path d="M8 4H6a2 2 0 0 0-2 2v3c0 1.7-1 3-2 3 1 0 2 1.3 2 3v3a2 2 0 0 0 2 2h2M16 4h2a2 2 0 0 1 2 2v3c0 1.7 1 3 2 3-1 0-2 1.3-2 3v3a2 2 0 0 1-2 2h-2"/>',
  },
  {
    id: 'minify',
    href: 'minify.html',
    label: 'navMinify',
    fallback: 'JSON Minify',
    icon: '<path d="M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5M3 8l5-5M21 8l-5-5M3 16l5 5M21 16l-5 5"/>',
  },
  {
    id: 'escape',
    href: 'escape.html',
    label: 'navEscape',
    fallback: 'JSON Escape',
    icon: '<path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M15 5l-6 14"/>',
  },
  {
    id: 'unescape',
    href: 'unescape.html',
    label: 'navUnescape',
    fallback: 'JSON Unescape',
    icon: '<path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M8 12h8M12 8l4 4-4 4"/>',
  },
  {
    id: 'compare',
    href: 'compare.html',
    label: 'navCompare',
    fallback: 'JSON Compare',
    icon: '<rect x="3" y="4" width="7" height="16" rx="1"/><rect x="14" y="4" width="7" height="16" rx="1"/><path d="M6 8h1M17 8h1M6 12h1M17 12h1M6 16h1M17 16h1"/>',
  },
];

const themeOptions = [
  {
    id: 'normal', label: 'themeNormal', fallback: 'Normal',
    icon: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/>',
  },
  {
    id: 'comfort', label: 'themeComfort', fallback: 'Eye comfort',
    icon: '<path d="M20 4C12 4 5 7 5 14c0 3 2 5 5 5 7 0 10-7 10-15Z"/><path d="M4 21c3-6 7-9 12-12"/>',
  },
  {
    id: 'dark', label: 'themeDark', fallback: 'Dark',
    icon: '<path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z"/>',
  },
];

function renderThemePreview(id) {
  return `<span class="theme-preview theme-preview-${id}" aria-hidden="true"><span class="preview-sidebar"><i></i><i></i><i></i></span><span class="preview-content"><i></i><b></b><b></b></span></span>`;
}

export function renderNavigation() {
  const currentPage = document.body.dataset.page;
  const theme = document.documentElement.dataset.theme || 'normal';
  const currentTheme = themeOptions.find((option) => option.id === theme) || themeOptions[0];
  const links = navItems.map((item) => {
    const active = item.id === currentPage;
    return `<a class="nav-link${active ? ' active' : ''}" href="${item.href}"${active ? ' aria-current="page"' : ''}>
      <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${item.icon}</svg>
      <span data-i18n="${item.label}">${item.fallback}</span>
    </a>`;
  }).join('');

  document.getElementById('sidebar').innerHTML = `
    <a class="brand" href="formatter.html">
      <span class="brand-mark">{ }</span>
      <span class="brand-name" data-i18n="appName">JSON Toolbox</span>
    </a>
    <div class="nav-heading" data-i18n="navTools">TOOLS</div>
    <nav class="main-nav" aria-label="JSON">${links}</nav>
    <div class="sidebar-bottom">
      <div class="theme-picker">
        <button id="theme-trigger" class="theme-trigger" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="theme-switch">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h3M11 17h9"/><circle cx="16" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>
          <span class="theme-trigger-copy"><span class="theme-trigger-title" data-i18n="themeLabel">Appearance</span><span id="theme-current" data-i18n="${currentTheme.label}">${currentTheme.fallback}</span></span>
          <svg class="theme-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>
        </button>
        <div id="theme-switch" class="theme-switch" role="dialog" aria-labelledby="theme-menu-title" hidden>
          <div class="theme-menu-heading"><strong id="theme-menu-title" data-i18n="themeLabel">Appearance</strong></div>
          <div class="theme-options">
            ${themeOptions.map((option) => `<button type="button" class="theme-option" data-theme-option="${option.id}" data-theme-label="${option.label}" aria-pressed="${option.id === theme}">
              ${renderThemePreview(option.id)}
              <span class="theme-option-caption"><svg class="theme-option-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${option.icon}</svg><span class="theme-option-name" data-i18n="${option.label}">${option.fallback}</span><svg class="theme-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg></span>
            </button>`).join('')}
          </div>
        </div>
      </div>
      <div class="sidebar-footer">
        <span class="local-dot" aria-hidden="true"></span>
        <span data-i18n="localOnly">All data stays on your device</span>
      </div>
    </div>
  `;
}
