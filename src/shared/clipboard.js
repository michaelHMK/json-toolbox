export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Browsers may still allow a user-initiated copy command.
  }
  const previousFocus = document.activeElement;
  const temporary = document.createElement('textarea');
  temporary.setAttribute('readonly', '');
  Object.assign(temporary.style, {
    position: 'fixed',
    top: '0',
    left: '-9999px',
    width: '1px',
    height: '1px',
    opacity: '0',
    pointerEvents: 'none',
  });
  // Avoid laying out multi-MiB text in a DOM textarea; supply the exact text in the copy event.
  temporary.value = text.length > 65536 ? ' ' : text;
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
