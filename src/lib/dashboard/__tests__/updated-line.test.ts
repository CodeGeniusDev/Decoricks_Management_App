/**
 * The dashboard's freshness sentence (brief item 1c: "show a visible 'last
 * updated' that stays honest").
 *
 * The report was a board reading "updated 12:39 am" many hours later with no
 * sign of anything wrong. Two properties are pinned because they are the two ways
 * that line can lie: it can name an instant fresher than the numbers on screen,
 * and it can name an hours-old instant as though it were current.
 */
import { describe, it, expect } from 'vitest'
import { updatedLine } from '@/lib/dashboard/updated-line'

describe('updatedLine', () => {
  it('says nothing is up to date before the first payload lands', () => {
    // "updated never" would be true and useless; the board is a skeleton anyway.
    expect(updatedLine(null, false)).toBe('updating…')
    expect(updatedLine(null, true)).toBe('updating…')
  })

  it('marks an aged snapshot as out of date rather than letting it read as fresh', () => {
    const fresh = updatedLine(Date.UTC(2026, 9, 10, 19, 39), false)
    const aged = updatedLine(Date.UTC(2026, 9, 10, 19, 39), true)
    expect(fresh).not.toMatch(/out of date|retrying/)
    expect(aged).toContain('out of date')
    expect(aged).toContain('retrying')
  })

  it('dates the line from the snapshot alone, so a failed refresh cannot make it look current', () => {
    // The same instant in and out of the stale state differs only in the clause —
    // the timestamp never moves to the time of the attempt that failed.
    const at = Date.UTC(2026, 9, 10, 19, 39)
    expect(updatedLine(at, true).startsWith(updatedLine(at, false))).toBe(true)
  })
})
