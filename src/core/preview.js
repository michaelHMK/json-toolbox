export const PREVIEW_LIMIT = 2000;

// Truncate a string without splitting a UTF-16 surrogate pair.
export function previewPrefix(text, limit = PREVIEW_LIMIT) {
  let end = Math.min(text.length, limit);
  if (end > 0 && end < text.length
      && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff
      && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) {
    end--;
  }
  return text.slice(0, end);
}
