'use client'

import React, { useId, useState } from 'react'
import { IconChevronDown, IconChevronUp, IconInfo } from './icons'

/**
 * HelpPanel — the one contextual-help pattern used across the app (Phase 2 §8).
 *
 * Deliberately modelled on `CalcPanel`: a quiet, full-width hairline strip with
 * a disclosure button, never a card, never a popup and never an overlay. It
 * explains the feature that is actually implemented — the content lives in the
 * page that owns the data, so the wording can be checked against the code.
 *
 * Behaviour:
 * - Open on the visitor's first call (`defaultOpen`), collapsed afterwards.
 * - Once the reader closes it, the choice is remembered per `persistKey` in
 *   localStorage, so help never nags the same person on every page load.
 * - Conditional render only: no animation library, nothing to tear down, and
 *   opening or closing it never navigates, reloads or refetches.
 * - Keyboard accessible: a real <button> with aria-expanded/aria-controls,
 *   44px hit area and the same focus ring as every other control.
 */

export interface HelpItem {
  /** The term as it appears on the screen, e.g. "Withdrawable". */
  title: string
  /** Plain-language explanation. No accounting jargon left unexplained. */
  body: string
}

interface HelpPanelProps {
  /** Question the panel answers, e.g. "How does budgeting work here?" */
  title?: string
  /** One or two sentences framing the whole panel. */
  intro?: string
  /** Term/meaning pairs — the shape most pages need. */
  items?: HelpItem[]
  /** Ordered workflow, only steps the implementation actually supports. */
  steps?: string[]
  /** Short closing line, e.g. where to go next. */
  footer?: string
  /**
   * Opt-in memory key, unique per screen (`'finance'`, `'budgets'`). Without it
   * the panel simply follows `defaultOpen` on every mount.
   */
  persistKey?: string
  /** First-visit state. Help that explains a page's purpose opens open. */
  defaultOpen?: boolean
  className?: string
}

const STORAGE_PREFIX = 'decoricks:help:'

/** Reads the remembered choice. Any storage failure means "no memory". */
const readPreference = (key: string | undefined, fallback: boolean): boolean => {
  if (!key) return fallback
  try {
    const stored = window.localStorage.getItem(`${STORAGE_PREFIX}${key}`)
    if (stored === '1') return true
    if (stored === '0') return false
  } catch {
    // Private mode / disabled storage: fall through to the default.
  }
  return fallback
}

const writePreference = (key: string | undefined, open: boolean): void => {
  if (!key) return
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${key}`, open ? '1' : '0')
  } catch {
    // The preference is a nicety; a failed write must not break the panel.
  }
}

export const HelpPanel = ({
  title = 'How does this work?',
  intro,
  items = [],
  steps = [],
  footer,
  persistKey,
  defaultOpen = false,
  className = '',
}: HelpPanelProps) => {
  // Lazy initialiser: read the remembered choice once, before the first paint,
  // so a returning reader never sees the panel flash open and shut.
  const [open, setOpen] = useState(() => readPreference(persistKey, defaultOpen))
  /* `useId()` returns a value whose delimiters are not legal in a CSS selector
     (`:r1:` on React 18, `«r1»` on React 19). The region it names has to be
     addressable — `aria-controls` is resolved with `#<id>` by the QA suite, and
     an unescaped colon makes that a selector parse error rather than a lookup.
     Keeping React's counter and dropping its punctuation preserves both the
     uniqueness across siblings and the guarantee that the string is identical
     on the server and the client, which hydration requires. The `help-` prefix
     also keeps the id a valid CSS identifier (it may not start with a digit). */
  const regionId = `help-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`

  const toggle = () => {
    setOpen((current) => {
      const next = !current
      writePreference(persistKey, next)
      return next
    })
  }

  if (items.length === 0 && steps.length === 0 && !intro && !footer) return null

  return (
    <div
      className={`rounded-lg border border-line-subtle bg-surface-sunken ${className}`}
      // QA hook: the phase-2 help suite asserts each panel by the question it
      // answers, so wording edits stay visible instead of silently dropping a
      // page's help. No styling or a11y meaning.
      data-help-title={title}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={toggle}
        className="flex min-h-[44px] w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-decoricks-dark focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-decoricks-brown"
      >
        <span className="flex items-center gap-1.5">
          <IconInfo size={14} className="shrink-0 text-ink-muted" />
          {open ? 'Hide this explanation' : title}
        </span>
        {open ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
      </button>

      {open && (
        <div id={regionId} className="border-t border-line-subtle px-3 py-3">
          {intro && <p className="text-xs leading-relaxed text-ink-secondary">{intro}</p>}

          {steps.length > 0 && (
            <ol className={`space-y-1.5 ${intro ? 'mt-3' : ''}`}>
              {steps.map((step, index) => (
                <li key={step} className="flex gap-2 text-xs leading-relaxed text-ink-secondary">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 shrink-0 tabular-nums font-semibold text-decoricks-brown"
                  >
                    {index + 1}.
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          )}

          {items.length > 0 && (
            <dl
              className={`grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 ${
                intro || steps.length > 0 ? 'mt-3' : ''
              }`}
            >
              {items.map((item) => (
                <div key={item.title}>
                  <dt className="text-xs font-semibold text-decoricks-dark">{item.title}</dt>
                  <dd className="mt-0.5 text-xs leading-relaxed text-ink-secondary">{item.body}</dd>
                </div>
              ))}
            </dl>
          )}

          {footer && <p className="mt-3 text-xs leading-relaxed text-ink-muted">{footer}</p>}
        </div>
      )}
    </div>
  )
}
