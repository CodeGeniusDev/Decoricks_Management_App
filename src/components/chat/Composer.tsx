'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { IconClose, IconUsers } from '@/components/ui/icons'
import { apiFetch } from '@/lib/api-client'
import {
  applyMentionPick,
  applyReferencePick,
  findActiveToken,
  rankByQuery,
  type ActiveToken,
} from './composer-tokens'
import { entityIcon, entityNoun } from './reference-visuals'
import {
  MAX_REFERENCES_PER_MESSAGE,
  referenceKey,
  type MentionMember,
  type ReferenceCandidate,
  type ReferenceType,
} from './types'
import type { KeyboardEvent } from 'react'

interface ComposerProps {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  disabled: boolean
  placeholder?: string
  /** Active, chat-readable members from `GET /api/chat/members`. */
  members: MentionMember[]
  /** Records queued for this message. Owned by the page, like the draft text. */
  references: ReferenceCandidate[]
  onAddReference: (candidate: ReferenceCandidate) => void
  onRemoveReference: (key: string) => void
}

/** One row in the open menu. Mention and reference rows share the keyboard model. */
type MenuItem =
  | { key: string; kind: 'mention'; member: MentionMember }
  | { key: string; kind: 'reference'; record: ReferenceCandidate }

/** Below the minimum query, `/` mode explains itself instead of showing nothing. */
const MIN_RECORD_QUERY = 2

/** Identity of an open token, so Escape can dismiss this one and still allow the
 *  next keystroke to re-open the menu for a different fragment. */
const tokenSignature = (token: ActiveToken): string => `${token.kind}:${token.start}:${token.query}`

const searchReferences = async (
  query: string,
  signal: AbortSignal
): Promise<{ types: ReferenceType[]; results: ReferenceCandidate[] }> => {
  const res = await apiFetch(`/api/chat/references?q=${encodeURIComponent(query)}`, { signal })
  const body = await res.json().catch(() => null)
  if (!res.ok || !body?.success) throw new Error(body?.error?.message ?? 'Search failed')
  return {
    types: (body.data?.types ?? []) as ReferenceType[],
    results: (body.data?.results ?? []) as ReferenceCandidate[],
  }
}

/**
 * Message input, with `@` member autocomplete and a `/` record picker.
 *
 * Deliberately a controlled textarea whose value is owned by the *page*, not
 * here, so a draft survives an offline period and a channel switch: the brief
 * requires the text to be kept when sending is disabled. Enter sends; Shift+
 * Enter inserts a newline, matching the mental model from the other partner
 * tools. The send button clears the 44px touch-target minimum.
 *
 * Two collaboration affordances sit on top of that same textarea, and both are
 * built so that nothing about them changes what a message means:
 *
 *  - `@` opens a member list. Choosing an entry writes the member's exact
 *    directory name into the text — the string the server is going to resolve
 *    back into a user id. Picking someone already mentioned collapses the
 *    fragment instead of appending a second copy, so the text can never hold a
 *    duplicate mention.
 *  - `/` searches real records across the modules this user may view and, on
 *    pick, queues the record as a chip and consumes the typed fragment. The
 *    message body keeps no copy of the record's name: the chip carries an id and
 *    the server re-reads the label every time the message is rendered, which is
 *    what makes it a reference rather than quoted text that can go stale.
 *
 * The menu never intercepts a keystroke it has not been asked to complete: with
 * no active token, Enter sends exactly as it always did, and Escape only closes
 * the menu (it re-opens as soon as the token changes).
 */
export function Composer({
  value,
  onChange,
  onSend,
  disabled,
  placeholder,
  members,
  references,
  onAddReference,
  onRemoveReference,
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const searchAbort = useRef<AbortController | null>(null)
  const [caret, setCaret] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [records, setRecords] = useState<ReferenceCandidate[]>([])
  const [types, setTypes] = useState<ReferenceType[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)

  const submit = () => {
    if (disabled || !value.trim()) return
    onSend()
    if (ref.current) ref.current.style.height = 'auto'
  }

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  /* ------------------------------ token state ----------------------------- */

  const token: ActiveToken | null = useMemo(
    () => (disabled ? null : findActiveToken(value, caret)),
    [value, caret, disabled]
  )

  /** Directory names, which is what the dedupe and the server both compare. */
  const memberNames = useMemo(() => members.map((m) => m.name), [members])

  const mentionOptions = useMemo(
    () =>
      token?.kind === 'mention' ? rankByQuery(members, (m) => m.name, token.query).slice(0, 8) : [],
    [token, members]
  )

  const menu: MenuItem[] = useMemo(() => {
    if (!token) return []
    if (token.kind === 'mention') {
      return mentionOptions.map((member) => ({
        key: `mention:${member.id}`,
        kind: 'mention' as const,
        member,
      }))
    }
    const chosen = new Set(references.map((r) => referenceKey(r)))
    return (
      rankByQuery(records, (r) => r.label, token.query)
        // A record already in the tray is not offered again, so a second pick
        // cannot queue the same id twice. Compared on the bare entity key — the
        // menu key carries a `reference:` prefix that would never match. Removed
        // before the slice, otherwise a full tray would shorten the list instead
        // of just excluding its own entries.
        .filter((record) => !chosen.has(referenceKey(record)))
        .slice(0, 12)
        .map((record) => ({
          key: `reference:${referenceKey(record)}`,
          kind: 'reference' as const,
          record,
        }))
    )
  }, [token, mentionOptions, records, references])

  /**
   * The menu is open only for a token that can actually be completed. A lone `/`
   * is a slash in prose until two characters make it a search, and a `@` with no
   * directory behind it (members still loading) must not render an empty box.
   */
  const menuOpen =
    !disabled &&
    token !== null &&
    dismissed !== tokenSignature(token) &&
    (token.kind === 'mention' ? mentionOptions.length > 0 : token.query.length >= MIN_RECORD_QUERY)

  /* ----------------------------- record search ---------------------------- */

  useEffect(() => {
    if (disabled || token?.kind !== 'reference' || token.query.length < MIN_RECORD_QUERY) {
      setSearching(false)
      return
    }
    const query = token.query
    setSearching(true)
    setSearchError(null)
    const controller = new AbortController()
    searchAbort.current?.abort()
    searchAbort.current = controller
    const timer = setTimeout(() => {
      searchReferences(query, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return
          setRecords(result.results)
          setTypes(result.types)
          setSearching(false)
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted || (err as Error)?.name === 'AbortError') return
          setRecords([])
          setSearchError(err instanceof Error ? err.message : 'Could not search records')
          setSearching(false)
        })
    }, 250)
    return () => clearTimeout(timer)
  }, [token, disabled])

  useEffect(() => () => searchAbort.current?.abort(), [])

  /* --------------------------- index + hint upkeep ------------------------- */

  useEffect(() => {
    setActiveIndex(0)
  }, [token?.kind, token?.query])

  useEffect(() => {
    if (!menuOpen) return
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, menuOpen])

  useEffect(() => {
    if (!hint) return
    const timer = setTimeout(() => setHint(null), 2600)
    return () => clearTimeout(timer)
  }, [hint])

  /* -------------------------------- picking ------------------------------- */

  const restoreCaret = useCallback((next: number) => {
    const el = ref.current
    if (!el) return
    // After React has written the new value; setting the selection earlier is
    // undone by the controlled re-render.
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(next, next)
      setCaret(next)
    })
  }, [])

  const pickMention = useCallback(
    (member: MentionMember) => {
      if (!token) return
      const edit = applyMentionPick(value, token, member.name, memberNames)
      onChange(edit.value)
      restoreCaret(edit.caret)
      setDismissed(null)
      if (edit.deduped) setHint(`${member.name} is already mentioned`)
    },
    [token, value, onChange, restoreCaret, memberNames]
  )

  const pickReference = useCallback(
    (record: ReferenceCandidate) => {
      if (!token) return
      if (references.length >= MAX_REFERENCES_PER_MESSAGE) {
        setHint(`A message can point at ${MAX_REFERENCES_PER_MESSAGE} records at most`)
        return
      }
      onAddReference(record)
      const edit = applyReferencePick(value, token)
      onChange(edit.value)
      restoreCaret(edit.caret)
      setRecords([])
      setDismissed(null)
    },
    [token, references.length, onAddReference, value, onChange, restoreCaret]
  )

  const pickAt = useCallback(
    (index: number) => {
      const item = menu[index]
      if (!item) return
      if (item.kind === 'mention') pickMention(item.member)
      else pickReference(item.record)
    },
    [menu, pickMention, pickReference]
  )

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (menu.length ? (i + 1) % menu.length : 0))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (menu.length ? (i - 1 + menu.length) % menu.length : 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        // Enter completes the selection; it does not send. Sending a half-typed
        // `@Afn` as literal text is the failure mode users report most often.
        e.preventDefault()
        pickAt(activeIndex)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        if (token) setDismissed(tokenSignature(token))
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const trackCaret = () => {
    if (ref.current) setCaret(ref.current.selectionStart ?? 0)
  }

  /* -------------------------------- render -------------------------------- */

  const referenceRows = types.length
    ? types.map((t) => t.label).join(', ')
    : 'records you have access to'

  return (
    <div className="relative">
      <div className="flex items-end gap-2">
        <div className="relative min-w-0 flex-1">
          {references.length > 0 && (
            <ul
              className="mb-2 flex flex-wrap gap-1.5"
              aria-label="Records attached to this message"
            >
              {references.map((record) => {
                const Icon = entityIcon(record.entityType)
                return (
                  <li
                    key={referenceKey(record)}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-surface-sunken py-1 pl-2 pr-1 text-xs text-ink-secondary"
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                    <span
                      className="truncate"
                      title={record.meta ? `${record.label} · ${record.meta}` : record.label}
                    >
                      {record.label}
                    </span>
                    <button
                      type="button"
                      onClick={() => onRemoveReference(referenceKey(record))}
                      aria-label={`Remove ${record.label} from this message`}
                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-ink-muted hover:bg-surface-raised hover:text-ink"
                    >
                      <IconClose className="h-3.5 w-3.5" />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          {menuOpen && (
            <div className="absolute bottom-full left-0 z-20 mb-2 w-full max-w-[22rem] overflow-hidden rounded-lg border border-line bg-surface-raised shadow-md">
              <ul
                ref={listRef}
                role="listbox"
                id="composer-suggestions"
                aria-label={token?.kind === 'mention' ? 'Team members' : 'Records'}
                className="max-h-64 overflow-y-auto py-1"
              >
                {menu.map((item, index) => {
                  const selected = index === activeIndex
                  if (item.kind === 'mention') {
                    return (
                      <li
                        key={item.key}
                        role="option"
                        id={`composer-option-${index}`}
                        aria-selected={selected}
                        onMouseDown={(e) => {
                          e.preventDefault()
                          pickMention(item.member)
                        }}
                        className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-sm ${
                          selected ? 'bg-surface-sunken text-ink' : 'text-ink-secondary'
                        }`}
                      >
                        <IconUsers className="h-4 w-4 shrink-0 text-ink-muted" />
                        <span className="truncate font-medium">{item.member.name}</span>
                      </li>
                    )
                  }
                  const Icon = entityIcon(item.record.entityType)
                  return (
                    <li
                      key={item.key}
                      role="option"
                      id={`composer-option-${index}`}
                      aria-selected={selected}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        pickReference(item.record)
                      }}
                      className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-sm ${
                        selected ? 'bg-surface-sunken text-ink' : 'text-ink-secondary'
                      }`}
                    >
                      <Icon className="h-4 w-4 shrink-0 text-ink-muted" />
                      <span className="min-w-0 flex-1 truncate">{item.record.label}</span>
                      <span className="shrink-0 text-2xs text-ink-muted">
                        {entityNoun(item.record.entityType)}
                      </span>
                    </li>
                  )
                })}
                {token?.kind === 'reference' && searching && (
                  <li className="px-3 py-2 text-xs text-ink-muted">Searching records…</li>
                )}
              </ul>
              {searchError && token?.kind === 'reference' && (
                <p className="border-t border-line-subtle px-3 py-2 text-xs text-status-danger">
                  {searchError}
                </p>
              )}
            </div>
          )}

          <textarea
            ref={ref}
            rows={1}
            value={value}
            onChange={(e) => {
              onChange(e.target.value)
              autoGrow(e.target)
              setCaret(e.target.selectionStart ?? 0)
            }}
            onKeyDown={onKey}
            onKeyUp={trackCaret}
            onClick={trackCaret}
            onSelect={trackCaret}
            onBlur={() => setDismissed(null)}
            disabled={disabled}
            placeholder={disabled ? 'Reconnecting…' : (placeholder ?? 'Type a message…')}
            aria-label="Message"
            aria-autocomplete="list"
            aria-controls={menuOpen ? 'composer-suggestions' : undefined}
            aria-activedescendant={menuOpen ? `composer-option-${activeIndex}` : undefined}
            autoComplete="off"
            spellCheck
            className="min-h-[44px] w-full resize-none rounded-lg border border-line bg-surface-raised px-3 py-2.5 text-sm text-ink placeholder:text-ink-muted focus:border-decoricks-brown focus:outline-none disabled:opacity-60"
          />

          {hint && (
            <p role="status" className="mt-1 text-xs text-ink-muted">
              {hint}
            </p>
          )}
          {!hint && !disabled && value.length === 0 && (
            /* Discoverability without redesign: the two triggers are named in the
               one place the user is already looking, and it disappears the moment
               they start typing an ordinary message. */
            <p className="mt-1 text-xs text-ink-muted">
              <span className="font-medium">@</span> to mention a teammate ·{' '}
              <span className="font-medium">/</span> to reference {referenceRows}
            </p>
          )}
          {!hint &&
            token?.kind === 'reference' &&
            token.query.length < MIN_RECORD_QUERY &&
            !disabled && (
              <p className="mt-1 text-xs text-ink-muted">Keep typing to search {referenceRows}</p>
            )}
        </div>

        <Button
          type="button"
          variant="primary"
          onClick={submit}
          disabled={disabled || !value.trim()}
          className="h-11 min-w-[44px] px-4"
        >
          Send
        </Button>
      </div>
    </div>
  )
}
