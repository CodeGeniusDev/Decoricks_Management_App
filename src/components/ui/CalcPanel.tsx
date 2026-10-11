'use client'

import React, { useId, useState } from 'react'
import Link from 'next/link'
import { IconChevronDown, IconChevronUp, IconInfo } from './icons'

/**
 * CalcPanel — the "Show calculation" disclosure every Phase 4 metric carries
 * (Phase 4 brief item 5). It states the formula, the exact input figures and
 * links to the underlying ledger records, so the Founder can verify any number
 * down to the transaction that produced it. Pure CSS/conditional render — no
 * animation library needed for a disclosure, and nothing to clean up.
 */

export interface CalcInput {
  label: string
  /** Pre-formatted display string; the panel never does arithmetic. */
  value: string
}

interface CalcPanelProps {
  /** One-line formula, ideally the exact string the API returned. */
  formula: string
  inputs?: CalcInput[]
  /** Link to the records behind the figures (usually a filtered ledger view). */
  link?: { href: string; label: string }
  note?: React.ReactNode
  /** Optional metric name shown on the closed button, e.g. "Net profit". */
  label?: string
  className?: string
}

export const CalcPanel = ({ formula, inputs = [], link, note, label, className = '' }: CalcPanelProps) => {
  const [open, setOpen] = useState(false)
  const panelId = useId()

  return (
    <div className={`rounded-lg border border-line-subtle bg-surface-sunken ${className}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-[44px] w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-decoricks-dark focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-decoricks-brown"
      >
        <span className="flex items-center gap-1.5">
          <IconInfo size={14} className="shrink-0 text-ink-muted" />
          {open ? 'Hide calculation' : 'Show calculation'}
          {label && <span className="font-normal text-ink-muted">· {label}</span>}
        </span>
        {open ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
      </button>
      {open && (
        <div id={panelId} className="border-t border-line-subtle px-3 py-2.5">
          <p className="text-xs">
            <span className="font-semibold text-decoricks-dark">Formula: </span>
            <span className="text-ink-secondary">{formula}</span>
          </p>
          {inputs.length > 0 && (
            <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
              {inputs.map((input) => (
                <div key={input.label} className="flex items-baseline justify-between gap-2">
                  <dt className="text-ink-muted">{input.label}</dt>
                  <dd className="font-semibold tabular-nums text-decoricks-dark">{input.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {link && (
            <Link
              href={link.href}
              className="mt-2 inline-block text-xs font-medium text-decoricks-brown hover:underline"
            >
              {link.label} →
            </Link>
          )}
          {note && <p className="mt-2 text-xs text-ink-muted">{note}</p>}
        </div>
      )}
    </div>
  )
}
