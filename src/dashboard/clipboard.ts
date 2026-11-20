/**
 * Iframe-safe clipboard helper.
 * Attempts the async Clipboard API when the document is focused, and falls back
 * cleanly to a temporary textarea + execCommand('copy') when embedded iframes
 * restrict navigator.clipboard.writeText.
 */

export async function copyTextSafely(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof window !== 'undefined' && document.hasFocus()) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to legacy textarea copy fallback
    }
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
