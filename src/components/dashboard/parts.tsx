'use client'

import React, { useId, useState } from 'react'
import { useRouter } from 'next/navigation'

import { Tooltip } from '@/components/ui/Tooltip'
import { IconInfo, IconChevronDown } from '@/components/ui/icons'

/**
 * Dashboard traceability primitives (Phase 8, METRICS.md §J).
 *
 * The brief requires that no dashboard number is untraceable. Two affordances
 * make that real in the UI, plus one click-through convention:
 *
 *   <MetricHelp>      — an always-visible definition on hover/focus (what the
 *                       number means and which engine produces it).
 *   <ShowCalculation> — an opt-in panel that prints the exact formula, the real
 *                       inputs it was computed from and the module/permission
 *                       gate, so a reviewer can re-derive the number by hand.
 *   ledgerHref()      — builds a deep link to the records behind a figure with
 *                       the filter pre-applied (type / category / account /
 *                       Karachi date range), so "verify against the ledger" is
 *                       one click, never a manual reconstruction.
 *
 * Everything here is presentation only; the numbers come from the server's
 * reconciled snapshot, so these components never recompute anything.
 */

/** Format a server UTC instant as the Karachi civil `YYYY-MM-DD` it belongs to. */
export function karachiInputDate(iso: string): string {
  const d = new Date(iso)
  // Reuse the canonical Karachi offset (UTC+5). `range.end` is the boundary
  // instant (e.g. day 23:59:59.999), so shifting and reading UTC parts gives the
  // civil day the engine actually bucketed the entry into.
  const shifted = new Date(d.getTime() + 5 * 3600_000)
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${m}-${day}`
}

/** The inclusive Karachi day window for the current selection, as input dates. */
export function rangeInputDates(range: { start: string; end: string }): {
  startDate: string
  endDate: string
} {
  return { startDate: karachiInputDate(range.start), endDate: karachiInputDate(range.end) }
}

/**
 * Deep link to the finance ledger with the period + a slice filter pre-applied.
 * The transactions screen reads exactly these params (type, category, accountId,
 * startDate, endDate) and opens filtered — the click-through is real, not a
 * decorative "learn more".
 */
export function ledgerHref(
  range: { start: string; end: string },
  filter: { type?: string; category?: string; accountId?: string } = {}
): string {
  const params = new URLSearchParams()
  if (filter.type) params.set('type', filter.type)
  if (filter.category) params.set('category', filter.category)
  if (filter.accountId) params.set('accountId', filter.accountId)
  const { startDate, endDate } = rangeInputDates(range)
  params.set('startDate', startDate)
  params.set('endDate', endDate)
  return `/finance/transactions?${params.toString()}`
}

interface MetricHelpProps {
  /** Plain-language definition — what the number measures (never marketing). */
  definition: string
  /** The engine that produces it, e.g. `computeProfitLoss` (SPEC §5.1). */
  engine: string
}

/** A small "i" affordance carrying the metric's definition + engine citation. */
export const MetricHelp = ({ definition, engine }: MetricHelpProps) => (
  <Tooltip content={`${definition} · Source: ${engine}`} position="top">
    <button
      type="button"
      aria-label={`What is this? ${definition}. Computed by ${engine}.`}
      className="inline-flex h-4 w-4 items-center justify-center rounded-full text-ink-muted transition-colors hover:text-decoricks-brown focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown"
    >
      <IconInfo size={13} />
    </button>
  </Tooltip>
)

export interface CalcRow {
  label: string
  value: string
  /** Emphasise the resolved figure (e.g. the resulting amount). */
  strong?: boolean
}

interface ShowCalculationProps {
  /** Human formula, e.g. "Gross Profit = Net Sales − COGS (SPEC §5.4)". */
  formula: string
  /** The real inputs the engine read, so the number is re-derivable. */
  rows: CalcRow[]
  /** Which module gate produced this block (METRICS §J). */
  gate: string
}

/**
 * Collapsible "Show calculation" panel. It stays mounted-but-hidden so opening
 * it never reflows the rest of the board, and a live background refresh does not
 * close it (the panel state is independent of the data), matching the "keep open
 * panel" rule.
 */
export const ShowCalculation = ({ formula, rows, gate }: ShowCalculationProps) => {
  const [open, setOpen] = useState(false)
  const panelId = useId()

  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded text-xs font-medium text-decoricks-brown transition-colors hover:text-decoricks-brown-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown"
      >
        <IconChevronDown
          size={14}
          className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
        {open ? 'Hide calculation' : 'Show calculation'}
      </button>
      {open && (
        <div
          id={panelId}
          className="mt-2 rounded-md border border-line-subtle bg-surface-sunken p-3 text-xs"
        >
          <p className="font-semibold text-decoricks-dark">{formula}</p>
          <dl className="mt-2 space-y-1">
            {rows.map((row) => (
              <div key={row.label} className="flex items-baseline justify-between gap-3">
                <dt className="min-w-0 text-ink-muted">{row.label}</dt>
                <dd
                  className={`shrink-0 tabular-nums ${
                    row.strong ? 'font-semibold text-decoricks-dark' : 'text-ink'
                  }`}
                >
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 border-t border-line-subtle pt-2 text-2xs text-ink-muted">
            Records behind this figure are one click away below · Permission gate: {gate}
          </p>
        </div>
      )}
    </div>
  )
}

/** A "view the records" link button used in every widget footer. */
export const TraceLink = ({ href, children }: { href: string; children: React.ReactNode }) => {
  const router = useRouter()
  return (
    <button
      type="button"
      onClick={() => router.push(href)}
      className="mt-2 inline-flex min-h-[44px] items-center gap-1 rounded text-xs font-medium text-decoricks-brown transition-colors hover:text-decoricks-brown-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown"
    >
      {children}
    </button>
  )
}
