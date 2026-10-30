import { describe, expect, it } from 'vitest'
import { safeRedirectPath } from '@/lib/safe-redirect'

/**
 * Item 4 — the one redirect the app follows on somebody else's instruction.
 *
 * `GET /login?next=…` is answered by a page anyone can link to, and the value is
 * followed with `router.replace` the instant credentials are accepted. The
 * original guard was `/^\/(?!\/)/`, the textbook check, and it is bypassable
 * three ways because the rule was written against the string rather than against
 * how a browser resolves it. Each case below is pinned from BOTH sides: what the
 * naive check says, and what `new URL()` — the parser the browser actually uses,
 * which strips tabs and newlines and folds backslashes before it looks for an
 * authority — really produces. That second assertion is the point of the file:
 * if URL semantics ever change, the test stops being a restatement of a comment.
 */
const BASE = 'https://app.decoricks.com/login'
const resolvesOffOrigin = (raw: string): boolean =>
  new URL(raw, BASE).origin !== new URL(BASE).origin

describe('safeRedirectPath — off-origin values are refused', () => {
  const attacks = [
    '//evil.com', // protocol-relative: the obvious one
    '/\\evil.com', // backslash folded to a slash, then read as an authority
    '/\t/evil.com', // tab removed before parsing, leaving //evil.com
    '/\n/evil.com', // same, via newline
    'https://evil.com', // absolute
    'http://evil.com/path',
    'javascript:alert(1)', // reachable by `next=javascript:…` if the rule were only "no leading slash"
    'data:text/html,x',
    '/evil.com\\@//evil.com',
    '',
    '   ',
  ]

  for (const raw of attacks) {
    it(`sends "${raw}" to the dashboard instead of following it`, () => {
      expect(safeRedirectPath(raw)).toBe('/')
    })
  }

  it('proves the bypasses defeat the naive "one leading slash" test', () => {
    // Recorded, not assumed. `//evil.com` was already caught by counting the
    // leading slashes; the two that slipped through are the ones the browser
    // normalises into that same shape AFTER the check runs — a backslash folded
    // to a slash, and a tab deleted outright. Both pass the old rule and both
    // leave the origin, which is why the guard rejects those characters instead
    // of only counting slashes.
    for (const raw of ['//evil.com', '/\\evil.com', '/\t/evil.com']) {
      expect(resolvesOffOrigin(raw), `${JSON.stringify(raw)} should escape the origin`).toBe(true)
      expect(safeRedirectPath(raw), `${JSON.stringify(raw)} must be refused`).toBe('/')
    }
    for (const raw of ['/\\evil.com', '/\t/evil.com']) {
      expect(/^\/(?!\/)/.test(raw), `naive check should accept ${JSON.stringify(raw)}`).toBe(true)
    }
    expect(/^\/(?!\/)/.test('//evil.com')).toBe(false)
  })

  it('accepts null, undefined and non-strings', () => {
    expect(safeRedirectPath(null)).toBe('/')
    expect(safeRedirectPath(undefined)).toBe('/')
    expect(safeRedirectPath(42 as unknown as string)).toBe('/')
  })
})

describe('safeRedirectPath — the app keeps every destination it should', () => {
  const legitimate = [
    '/',
    '/tasks',
    '/finance/transactions',
    '/budgets/0123456789abcdef01234567',
    '/inventory?search=chair',
    '/sales/details?id=abc',
    '/weekly-summary#chart',
    '/profit-loss/',
  ]

  for (const raw of legitimate) {
    it(`keeps ${raw}`, () => {
      expect(safeRedirectPath(raw)).toBe(raw)
      expect(resolvesOffOrigin(raw), `${raw} must stay on-origin`).toBe(false)
    })
  }
})
