/**
 * Phase 7 security primitives: message sanitisation (XSS) and the sliding-window
 * rate limiter. Both are pure and unit-covered here; the route tests confirm the
 * handlers actually call them.
 */
import { describe, it, expect } from 'vitest'
import { sanitizeMessageText } from '@/lib/sanitize'
import { SlidingWindowRateLimiter } from '@/lib/rate-limit'

describe('sanitizeMessageText', () => {
  it('removes a <script> block including its inner text', () => {
    const out = sanitizeMessageText('hello <script>alert(1)</script> world')
    expect(out).toBe('hello  world')
    expect(out).not.toContain('alert')
    expect(out).not.toContain('<script')
  })

  it('removes <style> content too', () => {
    expect(sanitizeMessageText('a<style>body{color:red}</style>b')).toBe('ab')
  })

  it('strips any leftover tag-shaped run, including an unterminated <', () => {
    expect(sanitizeMessageText('<img src=x onerror=alert(1)>')).toBe('')
    // A `<` with no closing `>` still swallows the rest of the tag-shaped run.
    expect(sanitizeMessageText('dangling <b old')).toBe('dangling')
  })

  it('is case-insensitive and survives obfuscated nesting', () => {
    const out = sanitizeMessageText('<ScRiPt>top.location="evil"</ScRiPt>safe')
    expect(out).toBe('safe')
  })

  it('removes control characters but keeps newlines and tabs of text', () => {
    const out = sanitizeMessageText('hi\x00there\x07')
    expect(out).toBe('hithere')
  })

  it('treats a stray "<" as markup and removes the run to the next ">"', () => {
    // Deliberately aggressive for basic-text-only chat: angle brackets are never
    // legitimate, so we strip rather than encode. A literal `a < b` loses the
    // operator — an accepted trade for never storing an executable payload.
    expect(sanitizeMessageText('a < b > c')).toBe('a  c')
    expect(sanitizeMessageText('5 < 10 and 3 > 1')).toBe('5  1')
  })

  it('collapses runs of blank lines and trims', () => {
    const out = sanitizeMessageText('  \n\n\n\nspam padded\n\n\n\n\nmessage  ')
    expect(out).toBe('spam padded\n\nmessage')
  })

  it('normalises CRLF to LF', () => {
    expect(sanitizeMessageText('line1\r\nline2')).toBe('line1\nline2')
  })
})

describe('SlidingWindowRateLimiter', () => {
  it('allows up to the limit then blocks with a positive retryAfter', () => {
    const rl = new SlidingWindowRateLimiter(3, 1000)
    expect(rl.consume('k', 0).allowed).toBe(true)
    expect(rl.consume('k', 100).allowed).toBe(true)
    expect(rl.consume('k', 200).allowed).toBe(true)

    const blocked = rl.consume('k', 300)
    expect(blocked.allowed).toBe(false)
    expect(blocked.remaining).toBe(0)
    // Oldest hit (0) leaves the window at 1000, so ~700ms remain at t=300.
    expect(blocked.retryAfterMs).toBe(700)
  })

  it('slides: once the oldest hit ages out a new one is allowed again', () => {
    const rl = new SlidingWindowRateLimiter(2, 1000)
    rl.consume('k', 0)
    rl.consume('k', 100)
    expect(rl.consume('k', 200).allowed).toBe(false)
    // At t=1100 the hit at 0 has aged out (> cutoff 100); 100 still live → room.
    expect(rl.consume('k', 1100).allowed).toBe(true)
  })

  it('keeps separate keys independent', () => {
    const rl = new SlidingWindowRateLimiter(1, 1000)
    expect(rl.consume('a', 0).allowed).toBe(true)
    expect(rl.consume('a', 10).allowed).toBe(false)
    expect(rl.consume('b', 10).allowed).toBe(true) // different bucket
  })

  it('release() forgets a key (an idempotent retry should not consume budget)', () => {
    const rl = new SlidingWindowRateLimiter(1, 1000)
    rl.consume('k', 0)
    expect(rl.consume('k', 1).allowed).toBe(false)
    rl.release('k')
    expect(rl.consume('k', 2).allowed).toBe(true)
  })

  it('sweeps stale buckets so the map cannot grow without bound', () => {
    const rl = new SlidingWindowRateLimiter(5, 1000)
    rl.consume('old', 0)
    // A much later consume on another key triggers a sweep past the window.
    rl.consume('fresh', 5000)
    // The 'old' bucket is empty now; re-consuming it starts clean.
    expect(rl.consume('old', 5001).allowed).toBe(true)
  })
})
