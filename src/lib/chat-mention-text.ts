/**
 * The mention text grammar — shared by the server that stores mentions, the
 * composer that inserts them and the message list that highlights them.
 *
 * It lives in its own module, with no database or React imports, for one
 * reason: all three of those surfaces have to agree about what counts as a
 * mention. If the server's boundary rule and the client's rendering rule drift
 * apart, a message shows a highlighted `@Ali` that produced no notification, or
 * the reverse — and neither is visible in a test that only exercises one side.
 *
 * The rule: a mention is `@` followed by a member's exact display name, where
 * the `@` is not glued to a word character on either side. So `@Ali Hassan`
 * mentions one person and not two, `@Alphabet` mentions nobody when "Ali" is on
 * the team, and `mail@decoricks` is an email address, not an alert.
 */

/** Boundary test: a character that would mean the `@` was glued to a word. */
export const MENTION_WORD_CHAR = /[\p{L}\p{N}_-]/u

/** One located `@Name` run inside a string. */
export interface MentionMatch {
  /** Index of the `@`. */
  start: number
  /** Index just past the name. */
  end: number
  /** The directory name that matched, exactly as stored. */
  name: string
}

/**
 * Locate every whole-word `@name` in `text`, in the order they appear.
 *
 * Longest-wins at a given offset, so a team holding both "Ali" and "Ali
 * Hassan" mentions the right person for `@Ali Hassan`. The same name appearing
 * twice yields two matches — this is a locator, not a de-duplicator; callers
 * that want one entry per person collapse by name themselves.
 */
export function findMentionMatches(text: string, names: readonly string[]): MentionMatch[] {
  if (!text || names.length === 0) return []

  const bestAtOffset = new Map<number, string>()
  for (const raw of names) {
    const name = raw.trim()
    if (!name) continue
    const needle = `@${name}`
    let from = 0
    for (;;) {
      const index = text.indexOf(needle, from)
      if (index === -1) break
      from = index + 1

      const before = index === 0 ? '' : text[index - 1]
      const afterIndex = index + needle.length
      const after = afterIndex < text.length ? text[afterIndex] : ''
      if (before && MENTION_WORD_CHAR.test(before)) continue
      if (after && MENTION_WORD_CHAR.test(after)) continue

      const incumbent = bestAtOffset.get(index)
      if (!incumbent || needle.length > `@${incumbent}`.length) {
        bestAtOffset.set(index, name)
      }
    }
  }

  return [...bestAtOffset.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, name]) => ({ start, end: start + name.length + 1, name }))
}

/**
 * There is deliberately no `isMentioned(text, name)` helper here. Checking one
 * name in isolation reads `@Ali Hassan` as a mention of `Ali` too, which is not
 * what the longest-wins resolver above stores. Callers that need "is this
 * person already in this text" run `findMentionMatches` over the whole
 * directory and compare the matched name, as the composer's dedupe does.
 */

/** A plain run of text, or a mention run — what the message list renders. */
export interface MentionSegment {
  text: string
  mention: boolean
  /** Set only on a mention segment, for the `title` tooltip. */
  name?: string
}

/**
 * Split text into plain and mention runs for rendering.
 *
 * Pure and name-driven rather than id-driven on purpose: `messageToJSON` ships
 * the mention's display name alongside its id, so the renderer needs no lookup
 * table and a re-named user's older messages still highlight the text that was
 * actually written at the time.
 */
export function segmentMentions(text: string, names: readonly string[]): MentionSegment[] {
  const matches = findMentionMatches(text, names)
  if (matches.length === 0) return [{ text, mention: false }]

  const segments: MentionSegment[] = []
  let cursor = 0
  for (const match of matches) {
    if (match.start > cursor) {
      segments.push({ text: text.slice(cursor, match.start), mention: false })
    }
    segments.push({ text: text.slice(match.start, match.end), mention: true, name: match.name })
    cursor = match.end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), mention: false })
  return segments
}
