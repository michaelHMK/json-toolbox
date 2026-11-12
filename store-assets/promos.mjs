import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Keep promotional copy separate from UI labels so each line reads naturally
// at both store image sizes. The extension catalog remains the brand source.
const COPY = {
  en: {
    header: 'BUILT FOR LARGE JSON',
    features: 'Import · Format · Compare',
    valueProposition: 'High performance. Private. Local.',
    device: 'All processing stays on your device.',
  },
  zh_CN: {
    header: '为大 JSON 而优化',
    features: '导入 · 格式化 · 对比',
    valueProposition: '高性能 · 重视隐私 · 本地处理',
    device: '所有处理均在你的设备上完成。',
  },
  fr: {
    header: 'CONÇU POUR LES JSON VOLUMINEUX',
    features: 'Importer · Formater · Comparer',
    valueProposition: 'Performant. Confidentiel. Local.',
    device: 'Tout est traité sur votre appareil.',
  },
  de: {
    header: 'FÜR GROSSE JSON-DATEN OPTIMIERT',
    features: 'Importieren · Formatieren · Vergleichen',
    valueProposition: 'Leistungsstark. Privat. Lokal.',
    device: 'Alle Daten werden auf Ihrem Gerät verarbeitet.',
    featureSizes: [16, 32],
  },
  ja: {
    header: '大容量 JSON に最適化',
    features: '読み込み · 整形 · 比較',
    valueProposition: '高性能・プライバシー重視・ローカル処理',
    device: 'すべての処理をお使いの端末で行います。',
  },
  ko: {
    header: '대용량 JSON에 최적화',
    features: '가져오기 · 서식 지정 · 비교',
    valueProposition: '고성능 · 개인정보 보호 · 로컬 처리',
    device: '모든 데이터는 내 기기에서 처리됩니다.',
    featureSizes: [18, 36],
  },
  es: {
    header: 'OPTIMIZADO PARA JSON DE GRAN TAMAÑO',
    features: 'Importar · Formatear · Comparar',
    valueProposition: 'Alto rendimiento. Privado. Local.',
    device: 'Todo se procesa en tu dispositivo.',
    featureSizes: [18, 36],
  },
  pt_BR: {
    header: 'OTIMIZADO PARA GRANDES ARQUIVOS JSON',
    features: 'Importar · Formatar · Comparar',
    valueProposition: 'Alto desempenho. Privacidade. Local.',
    device: 'Todos os dados são processados no seu dispositivo.',
    featureSizes: [18, 36],
  },
  pt_PT: {
    header: 'OTIMIZADO PARA GRANDES FICHEIROS JSON',
    features: 'Importar · Formatar · Comparar',
    valueProposition: 'Alto desempenho. Privacidade. Local.',
    device: 'Todos os dados são processados no seu dispositivo.',
    featureSizes: [18, 36],
  },
  ru: {
    header: 'ДЛЯ БОЛЬШИХ JSON-ДОКУМЕНТОВ',
    features: 'Импорт · Форматирование · Сравнение',
    valueProposition: 'Высокая производительность. Приватно. Локально.',
    device: 'Все данные обрабатываются на вашем устройстве.',
    featureSizes: [16, 31],
  },
  ar: {
    header: 'محسّن لملفات JSON الكبيرة',
    features: 'استيراد · تنسيق · مقارنة',
    valueProposition: 'أداء عالٍ. خصوصية. معالجة محلية.',
    device: 'تتم معالجة جميع البيانات على جهازك.',
  },
  zh_TW: {
    header: '為大型 JSON 而最佳化',
    features: '匯入 · 格式化 · 比對',
    valueProposition: '高效能 · 重視隱私 · 本機處理',
    device: '所有資料都在你的裝置上處理。',
  },
  zh_HK: {
    header: '專為大型 JSON 優化',
    features: '匯入 · 格式化 · 比較',
    valueProposition: '高效能 · 重視私隱 · 本機處理',
    device: '所有數據都在你的裝置上處理。',
  },
};

const FONTS = {
  zh_CN: 'Noto Sans CJK SC, Microsoft YaHei, sans-serif',
  zh_TW: 'Noto Sans CJK TC, Microsoft JhengHei, sans-serif',
  zh_HK: 'Noto Sans CJK HK, Noto Sans CJK TC, Microsoft JhengHei, sans-serif',
  ja: 'Noto Sans CJK JP, Yu Gothic, sans-serif',
  ko: 'Noto Sans CJK KR, Malgun Gothic, sans-serif',
  ar: 'Noto Sans Arabic, Arial, sans-serif',
};

function escapeXml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[char]);
}

function text(locale, value, { x, right, y, size, fill, weight = 400, brand = false }) {
  const rtl = locale === 'ar';
  // SVG's "start" anchor follows direction: for Arabic it is the right edge.
  // Keep the Latin brand LTR while aligning it to that same right edge.
  const direction = rtl && !brand ? 'rtl' : 'ltr';
  const anchor = rtl && brand ? 'end' : 'start';
  const font = (rtl && brand ? null : FONTS[locale]) || 'Arial, Noto Sans, sans-serif';
  // Leave a small inset for glyphs whose ink extends past their advance width.
  return `<text x="${rtl ? right - 1 : x + 1}" y="${y}" fill="${fill}" font-family="${font}" font-size="${size}" font-weight="${weight}" direction="${direction}" unicode-bidi="isolate" text-anchor="${anchor}" data-max-width="${right - x - 2}" data-min-x="${x}" data-max-x="${right}">${escapeXml(value)}</text>`;
}

function svgStart(width, height, locale) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" lang="${locale.replace('_', '-')}">
  <defs>
    <linearGradient id="bg" x2="1" y2="1"><stop stop-color="#635bff"/><stop offset="1" stop-color="#3e37a6"/></linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>`;
}

// Match the three palettes in styles/app.css. These are schematic UI previews,
// while the gallery screenshots are captured from the actual extension.
const THEMES = [
  { id: 'normal', label: 'themeNormal', bg: '#f7f8fc', panel: '#ffffff', subtle: '#fafbfc', border: '#e5e8ef', muted: '#697487', accent: '#635bff', soft: '#efefff', key: '#8b52b5', string: '#167c5b', radius: 5 },
  { id: 'comfort', label: 'themeComfort', bg: '#e9e4da', panel: '#f8f4eb', subtle: '#f1ecdf', border: '#ddd5c6', muted: '#716e63', accent: '#5f7056', soft: '#e3e7d8', key: '#8b6049', string: '#537253', radius: 8 },
  { id: 'dark', label: 'themeDark', bg: '#0e131a', panel: '#151b24', subtle: '#19212b', border: '#293340', muted: '#8491a3', accent: '#55d6be', soft: '#173a38', key: '#8caef5', string: '#a8d98e', radius: 3 },
];

function themePreview(theme, x, y, width, height, rtl = false) {
  // A miniature sidebar, options bar, and two code panes preserve the product's
  // recognizable shape without inventing text or displaying unreadable labels.
  const lines = [0, 1, 2, 3, 4, 5].map((row) => {
    const lineY = 83 + row * 15;
    const indent = row === 0 || row === 5 ? 0 : 5;
    return `<path d="M${48 + indent} ${lineY}h${row % 2 ? 20 : 24}" stroke="${theme.muted}" opacity=".65"/>
      <path d="M${100 + indent} ${lineY}h${row % 2 ? 10 : 14}" stroke="${theme.key}"/>
      <path d="M${117 + indent} ${lineY}h8" stroke="${theme.string}"/>`;
  }).join('');
  return `<g transform="translate(${x} ${y}) scale(${width / 150} ${height / 220})"><g${rtl ? ' transform="translate(150 0) scale(-1 1)"' : ''}>
    <rect x="0" y="5" width="150" height="220" rx="12" fill="#17134c" opacity=".18"/>
    <rect width="150" height="220" rx="12" fill="${theme.bg}" stroke="${theme.border}"/>
    <path d="M12 0h22v220H12q-12 0-12-12V12Q0 0 12 0Z" fill="${theme.panel}"/>
    <path d="M34 0v220" stroke="${theme.border}"/>
    <rect x="10" y="12" width="15" height="15" rx="${theme.radius}" fill="${theme.accent}"/>
    <rect x="6" y="42" width="23" height="13" rx="3" fill="${theme.soft}"/>
    <g stroke="${theme.muted}" stroke-width="3" stroke-linecap="round" opacity=".5">
      <path d="M11 48h13M11 67h11M11 86h11M11 105h11"/>
    </g>
    <rect x="44" y="14" width="40" height="5" rx="2.5" fill="${theme.muted}"/>
    <rect x="118" y="11" width="22" height="12" rx="3" fill="${theme.accent}"/>
    <rect x="44" y="35" width="96" height="15" rx="4" fill="${theme.panel}" stroke="${theme.border}"/>
    <path d="M50 42h16m8 0h7" stroke="${theme.muted}" stroke-width="3" stroke-linecap="round" opacity=".5"/>
    <rect x="43" y="60" width="46" height="147" rx="5" fill="${theme.panel}" stroke="${theme.border}"/>
    <rect x="95" y="60" width="46" height="147" rx="5" fill="${theme.panel}" stroke="${theme.border}"/>
    <path d="M44 72h44M96 72h44" stroke="${theme.border}"/>
    <g stroke-width="2.5" stroke-linecap="round">${lines}</g>
    <rect x="6" y="192" width="23" height="16" rx="3" fill="${theme.subtle}" stroke="${theme.border}"/>
    <path d="M11 200h13" stroke="${theme.accent}" stroke-width="3" stroke-linecap="round"/>
  </g></g>`;
}

function smallPromo(locale, brand, copy) {
  const line = (value, options) => text(locale, value, { x: 29, right: 411, ...options });
  return `${svgStart(440, 280, locale)}
  <circle cx="408" cy="8" r="126" fill="#b6b2ff" opacity=".14"/>
  <circle cx="10" cy="279" r="120" fill="#b6b2ff" opacity=".1"/>
  <rect x="29" y="34" width="112" height="112" rx="25" fill="#fff" opacity=".12"/>
  <g fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M65 60h-6q-7 0-7 8v11q0 11-9 11 9 0 9 11v11q0 8 7 8h6"/>
    <path d="M105 60h6q7 0 7 8v11q0 11 9 11-9 0-9 11v11q0 8-7 8h-6"/>
  </g>
  ${THEMES.map((theme, index) => themePreview(theme, 169 + index * 83, 35, 72, 119, locale === 'ar')).join('')}
  ${line(brand, { y: 208, size: 32, fill: '#fff', weight: 700, brand: true })}
  ${line(copy.features, { y: 239, size: copy.featureSizes?.[0] || 18, fill: '#eeedff' })}
  ${line(copy.valueProposition, { y: 264, size: 14, fill: '#eeedff', weight: 600 })}
</svg>
`;
}

function widePromo(locale, brand, copy, catalog) {
  const line = (value, options) => text(locale, value, { x: 80, right: 780, ...options });
  const rtl = locale === 'ar';
  const previews = THEMES.map((theme, index) => {
    const x = 830 + index * 164;
    const label = catalog[theme.label].message;
    return themePreview(theme, x, 153, 146, 244, rtl)
      + text(locale, label, { x: x + 8, right: x + 138, y: 431, size: 17, fill: '#eeedff', weight: 500 });
  }).join('');
  return `${svgStart(1400, 560, locale)}
  <circle cx="1315" cy="40" r="330" fill="#b6b2ff" opacity=".12"/>
  <circle cx="90" cy="650" r="310" fill="#b6b2ff" opacity=".1"/>
  <circle cx="1120" cy="312" r="224" fill="none" stroke="#d8d6ff" stroke-width="1" opacity=".15"/>
  <rect x="80" y="60" width="84" height="84" rx="21" fill="#fff" opacity=".13"/>
  <g transform="translate(88 72) scale(.63)" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M37 8h-6q-7 0-7 8v18q0 13-10 13 10 0 10 13v18q0 8 7 8h6"/>
    <path d="M69 8h6q7 0 7 8v18q0 13 10 13-10 0-10 13v18q0 8-7 8h-6"/>
  </g>
  ${line(copy.header, { x: 190, y: 112, size: 22, fill: '#eeedff', weight: 700 })}
  ${line(brand, { y: 250, size: 72, fill: '#fff', weight: 700, brand: true })}
  ${line(copy.features, { y: 330, size: copy.featureSizes?.[1] || 38, fill: '#eeedff' })}
  ${line(copy.valueProposition, { y: 402, size: 25, fill: '#eeedff', weight: 600 })}
  <circle cx="${rtl ? 771 : 89}" cy="459" r="5" fill="#a8efd7"/>
  ${line(copy.device, { x: rtl ? 80 : 106, right: rtl ? 754 : 780, y: 466, size: 20, fill: '#e0dfff' })}
  ${previews}
</svg>
`;
}

/** Write editable SVG sources and return the corresponding PNG capture jobs. */
export async function writePromoSources(assets, locale, catalog) {
  if (!Object.hasOwn(COPY, locale)) throw new Error(`Unsupported promo locale: ${locale}`);
  const brand = catalog?.extName?.message;
  if (typeof brand !== 'string' || !brand.trim()) throw new Error(`${locale}: missing extension brand`);
  await mkdir(join(assets, locale), { recursive: true });
  const jobs = [
    { width: 440, height: 280, source: smallPromo(locale, brand, COPY[locale]) },
    { width: 1400, height: 560, source: widePromo(locale, brand, COPY[locale], catalog) },
  ];
  const outputs = [];
  for (const { width, height, source } of jobs) {
    const stem = `${locale}/promo-${width}x${height}`;
    await writeFile(join(assets, `${stem}.svg`), source, 'utf8');
    outputs.push({ svg: `${stem}.svg`, png: `${stem}.png`, width, height });
  }
  return outputs;
}
