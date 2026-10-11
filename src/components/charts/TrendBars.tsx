'use client'

import React from 'react'
import { formatPaisa } from '@/lib/money'

/**
 * TrendBars — monthly profit trend (Phase 4 brief item 7 chart).
 *
 * One column per Karachi month. Positive months rise from the zero line in
 * brand dark; negative months drop below it in the danger colour — but every
 * column is labelled with its month and the accompanying table (visible at
 * all sizes) carries the exact figures, so the chart is never the only way to
 * read the data. Fixed-height flex columns: responsive down to 360px without
 * SVG text scaling artefacts.
 */

export interface TrendPoint {
  /** Short axis label, e.g. "Jan". */
  label: string
  /** Full accessible label, e.g. "Jan 26". */
  fullLabel: string
  /** Signed paisa. */
  value: number
}

export const TrendBars = ({ points, caption }: { points: TrendPoint[]; caption: string }) => {
  const maxAbs = Math.max(1, ...points.map((point) => Math.abs(point.value)))
  const hasNegatives = points.some((point) => point.value < 0)

  return (
    <figure className="m-0">
      <figcaption className="mb-3 text-xs font-medium text-ink-muted">{caption}</figcaption>
      <div aria-hidden="true">
        {/* Zero line splits the plot: positives above, negatives below. */}
        <div className="flex items-stretch gap-1" style={{ height: '10rem' }}>
          {points.map((point) => (
            <div key={point.fullLabel} className="flex min-w-0 flex-1 flex-col justify-end">
              <div className="flex flex-1 items-end">
                {point.value >= 0 && (
                  <div
                    className="w-full rounded-t-sm bg-decoricks-dark"
                    style={{ height: `${(point.value / maxAbs) * 100}%` }}
                    title={`${point.fullLabel}: ${formatPaisa(point.value)}`}
                  />
                )}
              </div>
              <div className="border-t border-line-strong" />
              <div className="flex flex-1 items-start">
                {point.value < 0 && (
                  <div
                    className="w-full rounded-b-sm bg-status-danger"
                    style={{ height: `${(-point.value / maxAbs) * 100}%` }}
                    title={`${point.fullLabel}: ${formatPaisa(point.value)}`}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-1 flex gap-1">
          {points.map((point) => (
            <span
              key={point.fullLabel}
              className="min-w-0 flex-1 truncate text-center text-2xs text-ink-muted"
            >
              {point.label}
            </span>
          ))}
        </div>
        {hasNegatives && (
          <p className="mt-1 text-2xs text-ink-muted">
            Months below the line lost money (negative net profit).
          </p>
        )}
      </div>
      {/* Exact figures, always — the chart is the picture, this is the data. */}
      <table className="mt-3 w-full text-left text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line-strong text-2xs uppercase tracking-wide text-ink-muted">
            <th scope="col" className="py-1.5 pr-2 font-semibold">
              Month
            </th>
            <th scope="col" className="py-1.5 text-right font-semibold">
              Net profit
            </th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.fullLabel} className="border-b border-line-subtle">
              <th scope="row" className="py-1.5 pr-2 text-left font-medium text-decoricks-dark">
                {point.fullLabel}
              </th>
              <td
                className={`py-1.5 text-right tabular-nums ${
                  point.value < 0 ? 'text-status-danger' : 'text-decoricks-dark'
                }`}
              >
                {formatPaisa(point.value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}
