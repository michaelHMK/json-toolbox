import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Keep promotional copy separate from UI labels so each line reads naturally
// at both store image sizes. The extension catalog remains the brand source.
const COPY = {
  en: {
    header: 'LOCAL JSON TOOLS',
    features: 'Import · Format · Compare',
    privacy: 'Private. Fully local.',
    device: 'All processing stays on your device.',
  },
  zh_CN: {
    header: '本地 JSON 工具',
    features: '导入 · 格式化 · 对比',
    privacy: '重视隐私 · 本地处理',
    device: '所有处理均在你的设备上完成。',
  },
  fr: {
    header: 'OUTILS JSON EN LOCAL',
    features: 'Importer · Formater · Comparer',
    privacy: 'Confidentiel. Tout en local.',
    device: 'Tout est traité sur votre appareil.',
  },
  de: {
    header: 'LOKALE JSON-WERKZEUGE',
    features: 'Importieren · Formatieren · Vergleichen',
    privacy: 'Privat. Alles lokal.',
    device: 'Alle Daten werden auf Ihrem Gerät verarbeitet.',
    featureSizes: [16, 32],
  },
  ja: {
    header: 'ローカル JSON ツール',
    features: '読み込み · 整形 · 比較',
    privacy: 'プライバシー重視。すべてローカル。',
    device: 'すべての処理をお使いの端末で行います。',
  },
  ko: {
    header: '로컬 JSON 도구',
    features: '가져오기 · 서식 지정 · 비교',
    privacy: '개인정보 보호. 모든 처리는 로컬에서.',
    device: '모든 데이터는 내 기기에서 처리됩니다.',
    featureSizes: [18, 36],
  },
  es: {
    header: 'HERRAMIENTAS JSON LOCALES',
    features: 'Importar · Formatear · Comparar',
    privacy: 'Privado. Todo en tu dispositivo.',
    device: 'Todo se procesa en tu dispositivo.',
    featureSizes: [18, 36],
  },
  pt_BR: {
    header: 'FERRAMENTAS JSON LOCAIS',
    features: 'Importar · Formatar · Comparar',
    privacy: 'Privacidade. Tudo no seu dispositivo.',
    device: 'Todos os dados são processados no seu dispositivo.',
    featureSizes: [18, 36],
  },
  pt_PT: {
    header: 'FERRAMENTAS JSON LOCAIS',
    features: 'Importar · Formatar · Comparar',
    privacy: 'Privacidade. Tudo no dispositivo.',
    device: 'Todos os dados são processados no seu dispositivo.',
    featureSizes: [18, 36],
  },
  ru: {
    header: 'ЛОКАЛЬНЫЕ ИНСТРУМЕНТЫ JSON',
    features: 'Импорт · Форматирование · Сравнение',
    privacy: 'Конфиденциально. Всё локально.',
    device: 'Все данные обрабатываются на вашем устройстве.',
    featureSizes: [16, 31],
  },
  ar: {
    header: 'أدوات JSON محلية',
    features: 'استيراد · تنسيق · مقارنة',
    privacy: 'الخصوصية أولاً. معالجة محلية.',
    device: 'تتم معالجة جميع البيانات على جهازك.',
  },
  zh_TW: {
    header: '本機 JSON 工具',
    features: '匯入 · 格式化 · 比對',
    privacy: '重視隱私 · 本機處理',
    device: '所有資料都在你的裝置上處理。',
  },
  zh_HK: {
    header: '本機 JSON 工具',
    features: '匯入 · 格式化 · 比較',
    privacy: '重視私隱 · 本機處理',
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
    <linearGradient id="bg" x2="1" y2="1"><stop stop-color="#253bba"/><stop offset="1" stop-color="#48259b"/></linearGradient>
    <linearGradient id="card" x2="1" y2="1"><stop stop-color="#fff"/><stop offset="1" stop-color="#e9edff"/></linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>`;
}

function smallPromo(locale, brand, copy) {
  const line = (value, options) => text(locale, value, { x: 29, right: 411, ...options });
  return `${svgStart(440, 280, locale)}
  <circle cx="408" cy="8" r="126" fill="#7f85f7" opacity=".15"/>
  <circle cx="10" cy="279" r="120" fill="#818cf8" opacity=".12"/>
  <rect x="29" y="34" width="112" height="112" rx="25" fill="#fff" opacity=".12"/>
  <g fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M65 60h-6q-7 0-7 8v11q0 11-9 11 9 0 9 11v11q0 8 7 8h6"/>
    <path d="M105 60h6q7 0 7 8v11q0 11 9 11-9 0-9 11v11q0 8-7 8h-6"/>
  </g>
  <g transform="translate(181 40)">
    <rect width="101" height="117" rx="12" fill="url(#card)"/>
    <rect x="116" width="112" height="117" rx="12" fill="url(#card)"/>
    <g stroke="#c0c8e8" stroke-width="5" stroke-linecap="round">
      <path d="M16 19h27m-27 18h57m-45 18h45m-45 18h34m-46 26h40"/>
      <path d="M132 19h27m-27 18h64m-52 18h45m-45 18h47m-59 26h52"/>
    </g>
    <rect x="10" y="62" width="81" height="22" rx="5" fill="#ffe3e1"/>
    <path d="M20 73h9m10 0h35" stroke="#d66966" stroke-width="4" stroke-linecap="round"/>
    <rect x="126" y="62" width="92" height="22" rx="5" fill="#d5f5e6"/>
    <path d="M136 73h10m-5-5v10m15-5h46" stroke="#23966b" stroke-width="4" stroke-linecap="round"/>
  </g>
  ${line(brand, { y: 208, size: 32, fill: '#fff', weight: 700, brand: true })}
  ${line(copy.features, { y: 239, size: copy.featureSizes?.[0] || 18, fill: '#dddfff' })}
  ${line(copy.privacy, { y: 264, size: 14, fill: '#d1d8fb' })}
</svg>
`;
}

function widePromo(locale, brand, copy) {
  const line = (value, options) => text(locale, value, { x: 80, right: 780, ...options });
  const rtl = locale === 'ar';
  return `${svgStart(1400, 560, locale)}
  <circle cx="1315" cy="40" r="330" fill="#7f85f7" opacity=".13"/>
  <circle cx="90" cy="650" r="310" fill="#818cf8" opacity=".11"/>
  <circle cx="1120" cy="312" r="224" fill="none" stroke="#a4afff" stroke-width="1" opacity=".18"/>
  <rect x="80" y="60" width="84" height="84" rx="21" fill="#fff" opacity=".13"/>
  <g transform="translate(88 72) scale(.63)" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M37 8h-6q-7 0-7 8v18q0 13-10 13 10 0 10 13v18q0 8 7 8h6"/>
    <path d="M69 8h6q7 0 7 8v18q0 13 10 13-10 0-10 13v18q0 8-7 8h-6"/>
  </g>
  ${line(copy.header, { x: 190, y: 112, size: 22, fill: '#e3e7ff', weight: 700 })}
  ${line(brand, { y: 250, size: 72, fill: '#fff', weight: 700, brand: true })}
  ${line(copy.features, { y: 330, size: copy.featureSizes?.[1] || 38, fill: '#e1e3ff' })}
  ${line(copy.privacy, { y: 402, size: 25, fill: '#e0e5ff' })}
  <circle cx="${rtl ? 771 : 89}" cy="459" r="5" fill="#a8efd7"/>
  ${line(copy.device, { x: rtl ? 80 : 106, right: rtl ? 754 : 780, y: 466, size: 20, fill: '#d1d8fb' })}
  <g transform="translate(830 146)">
    <rect x="0" y="8" width="212" height="282" rx="24" fill="#15174d" opacity=".18"/>
    <rect x="244" y="8" width="212" height="282" rx="24" fill="#15174d" opacity=".18"/>
    <rect width="212" height="282" rx="24" fill="url(#card)"/>
    <rect x="244" width="212" height="282" rx="24" fill="url(#card)"/>
    <g fill="#9caadc">
      <circle cx="26" cy="28" r="4"/><circle cx="42" cy="28" r="4"/><circle cx="58" cy="28" r="4"/>
      <circle cx="270" cy="28" r="4"/><circle cx="286" cy="28" r="4"/><circle cx="302" cy="28" r="4"/>
    </g>
    <g stroke="#bdc7e9" stroke-width="8" stroke-linecap="round">
      <path d="M28 67h57m-57 32h148m-118 32h108m-108 32h75m-105 85h99"/>
      <path d="M272 67h57m-57 32h148m-118 32h108m-108 32h96m-126 85h112"/>
    </g>
    <rect x="16" y="181" width="180" height="40" rx="9" fill="#ffe3e1"/>
    <path d="M33 201h17m20 0h100" stroke="#d66966" stroke-width="6" stroke-linecap="round"/>
    <rect x="260" y="181" width="180" height="40" rx="9" fill="#d5f5e6"/>
    <path d="M277 201h18m-9-9v18m29-9h98" stroke="#23966b" stroke-width="6" stroke-linecap="round"/>
  </g>
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
    { width: 1400, height: 560, source: widePromo(locale, brand, COPY[locale]) },
  ];
  const outputs = [];
  for (const { width, height, source } of jobs) {
    const stem = `${locale}/promo-${width}x${height}`;
    await writeFile(join(assets, `${stem}.svg`), source, 'utf8');
    outputs.push({ svg: `${stem}.svg`, png: `${stem}.png`, width, height });
  }
  return outputs;
}
