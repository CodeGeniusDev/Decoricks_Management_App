'use client'

import React from 'react'
import { formatPaisa } from '@/lib/money'

/**
 * BudgetBars — budget vs actual per category (Phase 4 brief item 7 chart).
 *
 * Paired horizontal bars on a shared scale, each with its value printed as
 * text next to it: the reading never depends on colour alone, and the
 * companion `<figcaption>` plus per-row status words keep it accessible. The
 * bars are plain divs (no SVG text scaling problems at 360px, no hydration
 * risk — the component only renders once data arrives client-side).
 */

export interface BudgetBarRow {
  label: string
  budgeted: number
  actual: number
  /** 'ok' | 'warning' | 'critical' — rendered as a word, not just a colour. */
  level: string
}

const LEVEL_WORD: Record<string, string> = {
  ok: 'within budget',
  warning: 'near limit',
  critical: 'over limit',
}

export const BudgetBars = ({ rows, caption }: { rows: BudgetBarRow[]; caption: string }) => {
  const max = Math.max(1, ...rows.map((row) => Math.max(row.budgeted, row.actual)))

  return (
    <figure className="m-0">
      <figcaption className="mb-3 text-xs font-medium text-ink-muted">{caption}</figcaption>
      <div
        className="mb-2 flex items-center gap-4 text-2xs text-ink-secondary"
        aria-hidden="true"
      >
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-decoricks-brown" /> Allocated
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-decoricks-dark" /> Spent
        </span>
      </div>
      <ul className="space-y-3" role="list">
        {rows.map((row) => (
          <li key={row.label}>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="truncate text-xs font-medium text-decoricks-dark">{row.label}</span>
              <span className="shrink-0 text-2xs text-ink-muted">
                {row.level === 'ok' ? LEVEL_WORD.ok : `${LEVEL_WORD[row.level] ?? row.level}`}
              </span>
            </div>
            <div className="space-y-1" aria-hidden="true">
              <div className="flex items-center gap-2">
                <div
                  className="h-2.5 min-w-[2px] rounded-sm bg-decoricks-brown"
                  style={{ width: `${(row.budgeted / max) * 100}%` }}
                />
                <span className="shrink-0 text-2xs tabular-nums text-ink-secondary">
                  {formatPaisa(row.budgeted)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div
                  className={`h-2.5 min-w-[2px] rounded-sm bg-decoricks-dark ${
                    row.level === 'critical' ? 'ring-1 ring-status-danger' : ''
                  }`}
                  style={{ width: `${(Math.max(0, row.actual) / max) * 100}%` }}
                />
                <span className="shrink-0 text-2xs tabular-nums text-ink-secondary">
                  {formatPaisa(row.actual)}
                </span>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {/* The same figures as text for screen readers and anyone who cannot
          see the bars — a real table, not a decorative one. Wrapped in the
          sr-only box rather than classed directly: width:1px does not
          constrain table layout, so a bare sr-only <table> grows past the
          viewport and adds horizontal scroll at phone widths. */}
      <div className="sr-only">
        <table>
          <caption>{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Allocated</th>
              <th scope="col">Spent</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{formatPaisa(row.budgeted)}</td>
                <td>{formatPaisa(row.actual)}</td>
                <td>{LEVEL_WORD[row.level] ?? row.level}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  )
}
