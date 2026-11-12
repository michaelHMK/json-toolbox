/*
 * 极简 i18n 桥：
 * - 扩展环境里走 chrome.i18n（读取 _locales 目录，语言跟随浏览器 UI 语言）
 * - 非扩展环境（本地 HTTP 预览、Node 测试）保留 HTML 里的英文兜底文案
 */

const hasI18n = typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getMessage;

export function t(key, substitutions) {
  if (!hasI18n) return key;
  return chrome.i18n.getMessage(key, substitutions) || key;
}

// 可访问名称和可见文本使用同一套翻译。
export function applyI18n() {
  if (!hasI18n) return;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.getAttribute('data-i18n'));
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.getAttribute('data-i18n-title'));
  }
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  }
  for (const el of document.querySelectorAll('[data-i18n-aria-label]')) {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
  }
  if (chrome.i18n.getUILanguage) {
    document.documentElement.lang = chrome.i18n.getUILanguage();
  }
  document.documentElement.dir = chrome.i18n.getMessage('@@bidi_dir') === 'rtl' ? 'rtl' : 'ltr';
}
