export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Browsers may still allow a user-initiated copy command.
  }
  const previousFocus = document.activeElement;
  const temporary = document.createElement('textarea');
  temporary.value = text;
  // The textarea normalizes CRLF. Supply the original to the copy event.
  temporary.addEventListener('copy', (event) => {
    if (!event.clipboardData) return;
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
  });
  document.body.appendChild(temporary);
  try {
    temporary.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    temporary.remove();
    previousFocus?.focus({ preventScroll: true });
  }
}
