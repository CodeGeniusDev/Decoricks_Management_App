/**
 * Where to send a user after they sign in.
 *
 * The login screen reads `?next=` so an interrupted visitor lands on the page
 * they originally wanted, and the value comes from a URL an attacker can hand
 * out (`https://app.example.com/login?next=…`). Following it after a successful
 * login is the classic open redirect: the victim's browser leaves the real app
 * at the exact moment their attention is trained on it, which is the most
 * effective place in any product to put a phishing page.
 *
 * The usual check — "starts with one slash" — is not enough on its own.
 * WHATWG URL parsing removes every ASCII tab and newline from the input before
 * it parses anything, and treats a backslash as a slash inside a special
 * scheme, so a value that has nothing wrong with it at the moment the regex runs
 * is a different value by the time the browser resolves it:
 *
 *   /\/evil.com    → https://evil.com/   (backslash normalised to a slash,
 *                                          which then starts the authority)
 *   /\t/evil.com   → https://evil.com/   (tab deleted first, leaving //evil.com)
 *   //evil.com     → https://evil.com/   (protocol-relative, the one the naive
 *                                          check does catch)
 *
 * So the rule is stated positively instead of being patched negatively: a root
 * relative path on this origin, no backslash, no whitespace or control
 * character, and nothing that could be read as an authority. Anything else is
 * not an error — the dashboard is a fine answer, and the user keeps the session
 * they just earned.
 */
export const safeRedirectPath = (raw: string | null | undefined): string => {
  if (typeof raw !== 'string' || raw.length === 0) return '/'
  // No tab/newline (removed before parsing), no carriage return, no NUL, and no
  // space — `next` is never hand-written, so an odd character is a probe.
  if (/[\s\u0000]/.test(raw)) return '/'
  // Backslash is normalised to a forward slash, so it cannot appear anywhere.
  if (raw.includes('\\')) return '/'
  // Must begin with exactly one slash: `//host` is an authority, not a path.
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/'
  return raw
}
