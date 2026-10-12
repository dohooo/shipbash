/**
 * The prose sanitizer a share passes every agent sentence through: it strips
 * control characters, URLs, addresses, and credential-shaped runs before a
 * public reader sees them, and bounds the length.
 */
export function sanitizeEventText(value: string, maximumCharacters: number): string {
  let safe = String(value)
    .normalize("NFKC")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: collapses control characters out of text before a reader sees it.
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/https?:\/\/\S+/giu, "[redacted-url]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[redacted-email]")
    .replace(/\b(?:Bearer\s+)?(?:sk|gh[pousr]|github_pat|xox[baprs])[-_A-Za-z0-9]{8,}\b/giu, "[redacted-secret]")
    .replace(/\b(?:authorization|api[_ -]?key|access[_ -]?token|secret|password)\s*[:=]\s*(?:Bearer\s+)?\S+/giu, "[redacted-secret]")
    .replace(/(?:\+?\d[\d ().-]{7,}\d)/gu, "[redacted-phone]")
    .replace(/\/Users\/[^/\s]+/gu, "/Users/[redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  if (!safe) safe = "No safe summary available.";
  return safe.length <= maximumCharacters
    ? safe
    : `${safe.slice(0, Math.max(0, maximumCharacters - 1)).trimEnd()}…`;
}
