/**
 * Phase 3 composer token logic and the shared mention grammar.
 *
 * The brief's mention requirements are mostly behavioural claims about text:
 * typing `@` opens a picker, picking a colleague writes exactly one clean
 * mention, an email address is never a mention, and a record picker choice
 * consumes its fragment without leaving debris. All of that is decided in pure
 * functions, so it is pinned here instead of hoping a screenshot catches it.
 *
 * The second half matters more than the first: the composer, the server that
 * stores mentions and the list that highlights them all read the SAME grammar
 * module, so a round-trip test here is what keeps those three surfaces from
 * drifting into "highlighted but never notified".
 */
import { describe, it, expect } from 'vitest'
import {
  applyMentionPick,
  applyReferencePick,
  findActiveToken,
  rankByQuery,
} from '../composer-tokens'
import { findMentionMatches, segmentMentions } from '@/lib/chat-mention-text'

const NAMES = ['Founder', 'Afnan Ali', 'Ali Hassan', 'Ali']

/* ---------------------------- which token is live ---------------------------- */

describe('findActiveToken', () => {
  it('reads a mention fragment at the end of the text', () => {
    const value = 'looping in @Af'
    const token = findActiveToken(value, value.length)
    expect(token).toEqual({ kind: 'mention', start: 11, end: 14, query: 'Af' })
  })

  it('opens on a bare @, because typing the trigger IS the intent', () => {
    expect(findActiveToken('@', 1)).toEqual({ kind: 'mention', start: 0, end: 1, query: '' })
  })

  it('follows the caret, not the end of the message', () => {
    // Editing an earlier mention mid-sentence is normal typing; the trailing
    // prose must not stop the menu, and the fragment must stop at the caret.
    const value = 'ping @Af now please'
    expect(findActiveToken(value, 8)).toEqual({ kind: 'mention', start: 5, end: 8, query: 'Af' })
    // …and once the caret is past the word, there is no token to complete.
    expect(findActiveToken(value, value.length)).toBeNull()
  })

  it('refuses an @ glued to a word, so an email is never a mention', () => {
    expect(findActiveToken('mail@decoricks', 14)).toBeNull()
    expect(findActiveToken('user@', 5)).toBeNull()
    // Also not a second mention on the same token.
    expect(findActiveToken('@@', 2)).toBeNull()
  })

  it('reads a reference fragment and ignores slashes inside words', () => {
    expect(findActiveToken('look at /ORD', 12)).toEqual({
      kind: 'reference',
      start: 8,
      end: 12,
      query: 'ORD',
    })
    expect(findActiveToken('/ord', 4)).toEqual({
      kind: 'reference',
      start: 0,
      end: 4,
      query: 'ord',
    })
    // Paths and ratios are prose, not a picker trigger.
    expect(findActiveToken('https://decoricks/', 18)).toBeNull()
    expect(findActiveToken('and/or', 6)).toBeNull()
  })

  it('spaces are allowed in a record query but not in a name query', () => {
    expect(findActiveToken('/Alina Sh', 9)?.query).toBe('Alina Sh')
    expect(findActiveToken('@Afnan Ali', 10)).toBeNull()
  })

  it('an empty caret position and out-of-range carets are safe', () => {
    expect(findActiveToken('', 0)).toBeNull()
    expect(findActiveToken('@Af', 99)).toEqual({ kind: 'mention', start: 0, end: 3, query: 'Af' })
    expect(findActiveToken('@Af', -5)).toBeNull()
  })
})

/* ------------------------------- picking ------------------------------- */

describe('applyMentionPick', () => {
  const tokenAt = (value: string) => findActiveToken(value, value.length)!

  it("writes the member's exact directory name and a trailing space", () => {
    const value = 'looping in @Af'
    const edit = applyMentionPick(value, tokenAt(value), 'Afnan Ali', NAMES)
    expect(edit.value).toBe('looping in @Afnan Ali ')
    expect(edit.caret).toBe(edit.value.length)
    expect(edit.deduped).toBe(false)
  })

  it('completes a hand-typed fragment instead of deleting it', () => {
    // `@Af` is the fragment being typed, so the duplicate scan must ignore it —
    // otherwise the very first mention would look like a repeat of itself.
    const value = '@Af'
    const edit = applyMentionPick(value, tokenAt(value), 'Afnan Ali', NAMES)
    expect(edit.deduped).toBe(false)
    expect(edit.value).toBe('@Afnan Ali ')
  })

  it('drops the fragment when the person is already mentioned elsewhere', () => {
    const value = '@Afnan Ali and @'
    const edit = applyMentionPick(value, tokenAt(value), 'Afnan Ali', NAMES)
    expect(edit.deduped).toBe(true)
    expect(edit.value).toBe('@Afnan Ali and ')
    // One mention of that person survives, and no `@ @` debris is left behind.
    expect(findMentionMatches(edit.value, NAMES)).toHaveLength(1)
  })

  it('keeps two different people who share a first name', () => {
    // `@Ali Hassan` stores ONE mention, for Ali Hassan. A naive per-name scan
    // would see `@Ali` inside it and refuse to complete a mention of Ali — the
    // dedupe has to use the same longest-wins resolver the server uses.
    const value = '@Ali Hassan with @'
    const edit = applyMentionPick(value, tokenAt(value), 'Ali', NAMES)
    expect(edit.deduped).toBe(false)
    expect(edit.value).toBe('@Ali Hassan with @Ali ')
  })

  it('inserts at the caret and keeps the rest of the sentence', () => {
    const value = 'cc @Af now'
    const edit = applyMentionPick(value, findActiveToken(value, 6)!, 'Afnan Ali', NAMES)
    expect(edit.value).toBe('cc @Afnan Ali  now')
    expect(edit.caret).toBe(14)
  })

  it('trims a stray space in the directory name before writing it', () => {
    const value = '@'
    const edit = applyMentionPick(value, tokenAt(value), '  Afnan Ali  ', NAMES)
    expect(edit.value).toBe('@Afnan Ali ')
  })
})

describe('applyReferencePick', () => {
  it('consumes the fragment entirely and writes no record text', () => {
    const value = '/ORD'
    const edit = applyReferencePick(value, findActiveToken(value, value.length)!)
    expect(edit.value).toBe('')
    expect(edit.caret).toBe(0)
  })

  it('rejoins the sentence around the removed fragment with one space', () => {
    const value = 'see /ORD one'
    // The caret sits just past `/ORD`; a query may contain spaces, so a caret
    // at the very end would swallow `one` into the fragment as well.
    const edit = applyReferencePick(value, findActiveToken(value, 8)!)
    expect(edit.value).toBe('see one')
    expect(edit.caret).toBe(3)
  })

  it('does not leave a dangling space when the fragment was last', () => {
    const value = 'see /ORD'
    const edit = applyReferencePick(value, findActiveToken(value, value.length)!)
    expect(edit.value).toBe('see')
    expect(edit.caret).toBe(3)
  })
})

/* ------------------------------- ranking ------------------------------- */

describe('rankByQuery', () => {
  const people = NAMES.map((name) => ({ name }))
  const text = (p: { name: string }) => p.name

  it('an empty query leaves the directory order untouched', () => {
    expect(rankByQuery(people, text, '').map(text)).toEqual(NAMES)
    expect(rankByQuery(people, text, '   ').map(text)).toEqual(NAMES)
  })

  it('prefix hits first, then word-prefix, then substring; non-matches drop', () => {
    // Ties keep directory order, which is why `Ali Hassan` precedes `Ali` here.
    const out = rankByQuery(people, text, 'ali').map(text)
    expect(out).toEqual(['Ali Hassan', 'Ali', 'Afnan Ali'])
    expect(out).not.toContain('Founder')
  })

  it('is case- and whitespace-insensitive', () => {
    expect(rankByQuery(people, text, '  AFNAN ').map(text)).toEqual(['Afnan Ali'])
  })
})

/* --------------------------- shared mention grammar --------------------------- */

describe('mention grammar shared with the server', () => {
  it('matches whole names only', () => {
    expect(findMentionMatches('hi @Ali', NAMES)).toEqual([{ start: 3, end: 7, name: 'Ali' }])
    expect(findMentionMatches('hi @Alphabet', NAMES)).toEqual([])
    expect(findMentionMatches('@Ali, ping', NAMES)).toHaveLength(1)
    expect(findMentionMatches('@AliHassan', ['Ali Hassan'])).toEqual([])
  })

  it('longest name wins at the same offset', () => {
    expect(findMentionMatches('@Ali Hassan', NAMES).map((m) => m.name)).toEqual(['Ali Hassan'])
  })

  it('a full name with a space is one mention, not two', () => {
    const matches = findMentionMatches('cc @Afnan Ali now', NAMES)
    expect(matches).toHaveLength(1)
    expect(matches[0].name).toBe('Afnan Ali')
  })

  it('the same person twice is two runs; the caller de-duplicates by name', () => {
    const matches = findMentionMatches('@Ali and @Ali', NAMES)
    expect(matches).toHaveLength(2)
    expect(new Set(matches.map((m) => m.name))).toEqual(new Set(['Ali']))
  })

  it('an email address never parses as a mention', () => {
    expect(findMentionMatches('mail@decoricks.com', ['decoricks'])).toEqual([])
  })

  it('segmentMentions splits into plain and mention runs in order', () => {
    expect(segmentMentions('ping @Afnan Ali please', NAMES)).toEqual([
      { text: 'ping ', mention: false },
      { text: '@Afnan Ali', mention: true, name: 'Afnan Ali' },
      { text: ' please', mention: false },
    ])
    expect(segmentMentions('nothing here', NAMES)).toEqual([
      { text: 'nothing here', mention: false },
    ])
  })

  it('round trip: whatever the composer inserts is what the server stores', () => {
    // The composer writes display text; the server re-resolves ids from it. If
    // these two disagreed, a message would highlight a name that nobody was
    // ever notified about — this single assertion is the guard against that.
    const value = 'looping in @Af'
    const edit = applyMentionPick(value, findActiveToken(value, value.length)!, 'Afnan Ali', NAMES)
    const resolved = findMentionMatches(edit.value, NAMES)
    expect(resolved).toEqual([{ start: 11, end: 21, name: 'Afnan Ali' }])
    expect(segmentMentions(edit.value, NAMES)[1]).toMatchObject({
      mention: true,
      name: 'Afnan Ali',
    })
  })
})
