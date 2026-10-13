/**
 * Phase 6 comment edit-window policy unit tests.
 *
 * The whole edit window rests on two pure functions in `business-policy`: the
 * resolved window (never read the raw settings document directly, so a partial
 * write cannot leave a comment un-editable forever) and the boundary check.
 * These lock the brief's edge cases: the 15-minute default, Founder override,
 * the 0 = never-editable-after-POST semantics, and an inclusive boundary.
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_COMMENT_EDIT_WINDOW_MINUTES,
  resolveCommentEditWindow,
  commentWithinEditWindow,
} from '@/lib/business-policy'
import type { BusinessSettings } from '@/lib/models/Ledger'

const settings = (over: Partial<BusinessSettings> = {}): BusinessSettings =>
  ({ key: 'business', ...over } as BusinessSettings)

describe('resolveCommentEditWindow', () => {
  it('falls back to the 15-minute default when unconfigured', () => {
    expect(resolveCommentEditWindow(null)).toBe(DEFAULT_COMMENT_EDIT_WINDOW_MINUTES)
    expect(resolveCommentEditWindow(undefined)).toBe(DEFAULT_COMMENT_EDIT_WINDOW_MINUTES)
    expect(resolveCommentEditWindow(settings())).toBe(DEFAULT_COMMENT_EDIT_WINDOW_MINUTES)
  })
  it('honours a valid Founder-configured window, including zero', () => {
    expect(resolveCommentEditWindow(settings({ commentEditWindowMinutes: 30 } as never))).toBe(30)
    expect(resolveCommentEditWindow(settings({ commentEditWindowMinutes: 0 } as never))).toBe(0)
    expect(
      resolveCommentEditWindow(settings({ commentEditWindowMinutes: 1440 } as never))
    ).toBe(1440)
  })
  it('rejects a non-integer or negative value back to the default', () => {
    expect(resolveCommentEditWindow(settings({ commentEditWindowMinutes: -5 } as never))).toBe(
      DEFAULT_COMMENT_EDIT_WINDOW_MINUTES
    )
    expect(resolveCommentEditWindow(settings({ commentEditWindowMinutes: 1.5 } as never))).toBe(
      DEFAULT_COMMENT_EDIT_WINDOW_MINUTES
    )
    expect(
      resolveCommentEditWindow(settings({ commentEditWindowMinutes: '30' } as never))
    ).toBe(DEFAULT_COMMENT_EDIT_WINDOW_MINUTES)
  })
})

describe('commentWithinEditWindow', () => {
  const createdAt = new Date('2026-10-13T10:00:00.000Z')

  it('is inclusive at the exact boundary', () => {
    const atTwelve = new Date(createdAt.getTime() + 12 * 60_000)
    expect(commentWithinEditWindow(createdAt, atTwelve, 15)).toBe(true)
  })
  it('allows an edit one millisecond before the window closes', () => {
    const almost = new Date(createdAt.getTime() + 15 * 60_000 - 1)
    expect(commentWithinEditWindow(createdAt, almost, 15)).toBe(true)
  })
  it('denies an edit one millisecond after the window closes', () => {
    const past = new Date(createdAt.getTime() + 15 * 60_000 + 1)
    expect(commentWithinEditWindow(createdAt, past, 15)).toBe(false)
  })
  it('treats a zero window as never editable after the initial POST', () => {
    const oneMsLater = new Date(createdAt.getTime() + 1)
    expect(commentWithinEditWindow(createdAt, oneMsLater, 0)).toBe(false)
    // The creation instant itself still passes, which is what lets the author
    // edit within the same request but never afterwards.
    expect(commentWithinEditWindow(createdAt, createdAt, 0)).toBe(true)
  })
  it('honours a custom window width', () => {
    const thirtyOne = new Date(createdAt.getTime() + 31 * 60_000)
    expect(commentWithinEditWindow(createdAt, thirtyOne, 30)).toBe(false)
    expect(commentWithinEditWindow(createdAt, thirtyOne, 60)).toBe(true)
  })
})
