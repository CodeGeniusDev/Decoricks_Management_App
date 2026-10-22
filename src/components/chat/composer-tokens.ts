/**
 * Composer token logic — the pure half of `@` mentions and `/` references.
 *
 * Deciding "which token is the caret inside, and how do I replace it" is the
 * part of an autocomplete that goes wrong quietly: the dropdown opens for the
 * wrong text, a pick is inserted in the middle of an existing word, or selecting
 * the same colleague twice writes `@Ali @Ali`. None of those are visible in a
 * screenshot, all of them are visible in a unit test, so the logic lives here as
 * plain functions over strings and indices, with no DOM and no React.
 */

import { findMentionMatches } from '@/lib/chat-mention-text'

/** The two triggers the composer understands. */
export type TokenKind = 'mention' | 'reference'

export interface ActiveToken {
  kind: TokenKind
  /** Index of the trigger character (`@` or `/`). */
  start: number
  /** Index just past the typed fragment — the caret while the menu is open. */
  end: number
  /** What has been typed after the trigger, exactly as written. */
  query: string
}

/**
 * A `@` starts a mention only when it is not glued to a word character — the
 * same boundary rule the server applies when it resolves mentions, so the menu
 * never offers to complete something the server would refuse to store (an email
 * address, a tag, a price). A trailing `@` with nothing after it still counts:
 * typing `@` is the intent to mention.
 */
const MENTION_TOKEN = /(?:^|[^\p{L}\p{N}_@-])@([\p{L}\p{N}_-]*)$/u

/**
 * A `/` starts a record reference only at the start of the text or after
 * whitespace, so `https://x` and `and/or` are left alone. Spaces are allowed in
 * the fragment because record names contain them.
 */
const REFERENCE_TOKEN = /(?:^|\s)\/([\p{L}\p{N} _-]{0,60})$/u

/**
 * Which token, if any, the caret currently sits inside.
 *
 * Only the text before the caret is examined, so a menu follows the cursor and
 * not the end of the message: moving the caret back into an earlier `@Ali` and
 * continuing to type is normal editing behaviour, and pasting a URL that ends in
 * `/` must not open a picker over the whole message.
 */
export function findActiveToken(value: string, caret: number): ActiveToken | null {
  const upto = value.slice(0, Math.max(0, Math.min(caret, value.length)))

  const mention = MENTION_TOKEN.exec(upto)
  if (mention) {
    const query = mention[1] ?? ''
    const start = mention.index + (mention[0].length - query.length - 1)
    return { kind: 'mention', start, end: upto.length, query }
  }

  const reference = REFERENCE_TOKEN.exec(upto)
  if (reference) {
    const query = reference[1] ?? ''
    const start = reference.index + (reference[0].length - query.length - 1)
    return { kind: 'reference', start, end: upto.length, query }
  }

  return null
}

export interface TokenEdit {
  value: string
  /** Where the caret should sit after the edit. */
  caret: number
  /** True when the pick was refused because it would have been a duplicate. */
  deduped: boolean
}

/**
 * Apply a mention pick, replacing the fragment the user typed.
 *
 * Inserts the member's exact directory name so the server's resolution matches
 * the same string the reader sees, and appends a space so the next keystroke is
 * prose rather than more of the token.
 *
 * If the message ALREADY mentions this person somewhere other than the fragment
 * being typed, the fragment is removed instead of another copy being written.
 * That is the brief's "no invalid or duplicate mention text": the user ends up
 * with one clean mention, the caret lands where they expect, and the flag lets
 * the composer say so rather than silently eating the keystroke. Testing the
 * text with this fragment excised (rather than the whole value) is what keeps a
 * hand-typed `@Afnan` being *completed* instead of deleted.
 *
 * The duplicate scan runs the server's own resolver over the WHOLE directory,
 * not just this name, so it agrees with what will actually be stored: a team
 * holding both `Ali` and `Ali Hassan` writes `@Ali Hassan` for one person, and
 * picking `Ali` afterwards must not be refused as a repeat of that mention.
 */
export function applyMentionPick(
  value: string,
  token: ActiveToken,
  name: string,
  directory: readonly string[] = [name]
): TokenEdit {
  const head = value.slice(0, token.start)
  const tail = value.slice(token.end)
  const trimmed = name.trim()

  const already = findMentionMatches(head + tail, directory).some((m) => m.name === trimmed)
  if (already) {
    return { value: head + tail, caret: head.length, deduped: true }
  }

  const inserted = `@${trimmed} `
  return { value: head + inserted + tail, caret: head.length + inserted.length, deduped: false }
}

/**
 * Apply a reference pick: the `/query` fragment is consumed entirely, because
 * the record lives in a chip below the input, not in the text. Nothing is
 * appended to the message body — a copied label would be exactly the stale-text
 * reference this feature exists to avoid.
 *
 * The words the fragment was sitting between are rejoined with a single space:
 * a token is only ever preceded by a boundary, so leaving both sides untouched
 * would park a double space in the middle of the sentence.
 */
export function applyReferencePick(value: string, token: ActiveToken): TokenEdit {
  const head = value.slice(0, token.start).replace(/\s+$/, '')
  const tail = value.slice(token.end).replace(/^\s+/, '')
  const joined = head && tail ? `${head} ${tail}` : head + tail
  return { value: joined, caret: Math.min(head.length, joined.length), deduped: false }
}

/** Ranking for the mention list: prefix hits first, then substring, then the rest. */
export function rankByQuery<T>(items: T[], textOf: (item: T) => string, query: string): T[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return items
  const score = (item: T): number => {
    const text = textOf(item).toLowerCase()
    if (text.startsWith(needle)) return 0
    if (text.split(/\s+/).some((word) => word.startsWith(needle))) return 1
    return text.includes(needle) ? 2 : 3
  }
  return items
    .map((item, index) => ({ item, index, rank: score(item) }))
    .filter((entry) => entry.rank < 3)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.item)
}
