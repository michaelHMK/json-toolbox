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

export function renderNavigation() {
  const currentPage = document.body.dataset.page;
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
    <div class="sidebar-footer">
      <span class="local-dot" aria-hidden="true"></span>
      <span data-i18n="localOnly">All data stays on your device</span>
    </div>
  `;
}
