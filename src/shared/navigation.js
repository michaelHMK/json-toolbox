const SVG_NS = 'http://www.w3.org/2000/svg';

const navItems = [
  {
    id: 'format',
    href: 'formatter.html',
    label: 'navFormat',
    fallback: 'JSON Formatter',
    shapes: [
      ['path', { d: 'M8 4H6a2 2 0 0 0-2 2v3c0 1.7-1 3-2 3 1 0 2 1.3 2 3v3a2 2 0 0 0 2 2h2M16 4h2a2 2 0 0 1 2 2v3c0 1.7 1 3 2 3-1 0-2 1.3-2 3v3a2 2 0 0 1-2 2h-2' }],
    ],
  },
  {
    id: 'minify',
    href: 'minify.html',
    label: 'navMinify',
    fallback: 'JSON Minify',
    shapes: [
      ['path', { d: 'M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5M3 8l5-5M21 8l-5-5M3 16l5 5M21 16l-5 5' }],
    ],
  },
  {
    id: 'escape',
    href: 'escape.html',
    label: 'navEscape',
    fallback: 'JSON Escape',
    shapes: [
      ['path', { d: 'M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M15 5l-6 14' }],
    ],
  },
  {
    id: 'unescape',
    href: 'unescape.html',
    label: 'navUnescape',
    fallback: 'JSON Unescape',
    shapes: [
      ['path', { d: 'M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M8 12h8M12 8l4 4-4 4' }],
    ],
  },
  {
    id: 'compare',
    href: 'compare.html',
    label: 'navCompare',
    fallback: 'JSON Compare',
    shapes: [
      ['rect', { x: '3', y: '4', width: '7', height: '16', rx: '1' }],
      ['rect', { x: '14', y: '4', width: '7', height: '16', rx: '1' }],
      ['path', { d: 'M6 8h1M17 8h1M6 12h1M17 12h1M6 16h1M17 16h1' }],
    ],
  },
];

const themeOptions = [
  {
    id: 'normal', label: 'themeNormal', fallback: 'Normal',
    shapes: [
      ['circle', { cx: '12', cy: '12', r: '4' }],
      ['path', { d: 'M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41' }],
    ],
  },
  {
    id: 'comfort', label: 'themeComfort', fallback: 'Eye comfort',
    shapes: [
      ['path', { d: 'M20 4C12 4 5 7 5 14c0 3 2 5 5 5 7 0 10-7 10-15Z' }],
      ['path', { d: 'M4 21c3-6 7-9 12-12' }],
    ],
  },
  {
    id: 'dark', label: 'themeDark', fallback: 'Dark',
    shapes: [
      ['path', { d: 'M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z' }],
    ],
  },
];

function el(tag, attrs = null, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'hidden' && value === true) node.hidden = true;
      else node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function svgIcon(className, shapes, strokeWidth = '1.7') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', strokeWidth);
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of shapes) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, value);
    svg.appendChild(shape);
  }
  return svg;
}

function createThemePreview(id) {
  return el('span', { class: `theme-preview theme-preview-${id}`, 'aria-hidden': 'true' },
    el('span', { class: 'preview-sidebar' }, el('i'), el('i'), el('i')),
    el('span', { class: 'preview-content' }, el('i'), el('b'), el('b')),
  );
}

export function renderNavigation() {
  const currentPage = document.body.dataset.page;
  const theme = document.documentElement.dataset.theme || 'normal';
  const currentTheme = themeOptions.find((option) => option.id === theme) || themeOptions[0];

  const brand = el('a', { class: 'brand', href: 'formatter.html' },
    el('span', { class: 'brand-mark' }, '{ }'),
    el('span', { class: 'brand-name', 'data-i18n': 'appName' }, 'JSON Toolbox'),
  );

  const heading = el('div', { class: 'nav-heading', 'data-i18n': 'navTools' }, 'TOOLS');

  const nav = el('nav', { class: 'main-nav', 'aria-label': 'JSON' },
    ...navItems.map((item) => {
      const active = item.id === currentPage;
      return el('a', {
        class: active ? 'nav-link active' : 'nav-link',
        href: item.href,
        'aria-current': active ? 'page' : null,
      },
        svgIcon('nav-icon', item.shapes),
        el('span', { 'data-i18n': item.label }, item.fallback),
      );
    }),
  );

  const themeTrigger = el('button', {
    id: 'theme-trigger',
    class: 'theme-trigger',
    type: 'button',
    'aria-haspopup': 'dialog',
    'aria-expanded': 'false',
    'aria-controls': 'theme-switch',
  },
    svgIcon('nav-icon', [
      ['path', { d: 'M4 7h10M18 7h2M4 17h3M11 17h9' }],
      ['circle', { cx: '16', cy: '7', r: '2' }],
      ['circle', { cx: '9', cy: '17', r: '2' }],
    ]),
    el('span', { class: 'theme-trigger-copy' },
      el('span', { class: 'theme-trigger-title', 'data-i18n': 'themeLabel' }, 'Appearance'),
      el('span', { id: 'theme-current', 'data-i18n': currentTheme.label }, currentTheme.fallback),
    ),
    svgIcon('theme-chevron', [['path', { d: 'm7 10 5 5 5-5' }]]),
  );

  const themeSwitch = el('div', {
    id: 'theme-switch',
    class: 'theme-switch',
    role: 'dialog',
    'aria-labelledby': 'theme-menu-title',
    hidden: true,
  },
    el('div', { class: 'theme-menu-heading' },
      el('strong', { id: 'theme-menu-title', 'data-i18n': 'themeLabel' }, 'Appearance'),
    ),
    el('div', { class: 'theme-options' },
      ...themeOptions.map((option) => el('button', {
        type: 'button',
        class: 'theme-option',
        'data-theme-option': option.id,
        'data-theme-label': option.label,
        'aria-pressed': String(option.id === theme),
      },
        createThemePreview(option.id),
        el('span', { class: 'theme-option-caption' },
          svgIcon('theme-option-icon', option.shapes),
          el('span', { class: 'theme-option-name', 'data-i18n': option.label }, option.fallback),
          svgIcon('theme-check', [['path', { d: 'm5 12 4 4L19 6' }]], '2'),
        ),
      )),
    ),
  );

  const bottom = el('div', { class: 'sidebar-bottom' },
    el('div', { class: 'theme-picker' }, themeTrigger, themeSwitch),
    el('div', { class: 'sidebar-footer' },
      el('span', { class: 'local-dot', 'aria-hidden': 'true' }),
      el('span', { 'data-i18n': 'localOnly' }, 'All data stays on your device'),
    ),
  );

  document.getElementById('sidebar').replaceChildren(brand, heading, nav, bottom);
}
