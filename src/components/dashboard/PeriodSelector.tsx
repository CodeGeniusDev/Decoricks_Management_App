'use client'

import React, { useCallback } from 'react'
import { Button } from '@/components/ui/Button'
import { IconRefresh } from '@/components/ui/icons'
import type { DashboardPeriod } from '@/lib/dashboard/useDashboard'

/**
 * Period selector — the dashboard's single range control (METRICS.md §0.2).
 *
 * The four options map exactly onto `resolveReportRange` on the server:
 * today→day, this week→week, this month→month, custom→custom(from,to), all on
 * Asia/Karachi civil boundaries. Dates are entered as `YYYY-MM-DD`; the server
 * parses them as Karachi days and rejects an inverted or incomplete custom
 * range with 400 — so we never send one: switching to Custom seeds today's
 * Karachi date into both bounds, and the two inputs are cross-clamped.
 */

const OPTIONS: { value: DashboardPeriod; label: string }[] = [
  { value: 'day', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'custom', label: 'Custom' },
]

/** Today's Karachi civil date as a `YYYY-MM-DD` input value. */
function karachiToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

interface PeriodSelectorProps {
  period: DashboardPeriod
  customFrom: string
  customTo: string
  onPeriod: (p: DashboardPeriod) => void
  onCustomRange: (from: string, to: string) => void
  onRefresh: () => void
  refreshing: boolean
}

export const PeriodSelector = ({
  period,
  customFrom,
  customTo,
  onPeriod,
  onCustomRange,
  onRefresh,
  refreshing,
}: PeriodSelectorProps) => {
  const today = karachiToday()

  const choose = useCallback(
    (p: DashboardPeriod) => {
      onPeriod(p)
      // Seeding a valid custom window on entry avoids a guaranteed 400 while the
      // user has not yet picked dates.
      if (p === 'custom' && (!customFrom || !customTo)) {
        onCustomRange(today, today)
      }
    },
    [onPeriod, onCustomRange, customFrom, customTo, today]
  )

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
      <div
        role="group"
        aria-label="Reporting period"
        className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-line-subtle bg-surface-raised p-1"
      >
        {OPTIONS.map((opt) => {
          const active = period === opt.value
          return (
            <button
              key={opt.value}
              type="button"
              aria-pressed={active}
              onClick={() => choose(opt.value)}
              className={`min-h-[36px] rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown ${
                active
                  ? 'bg-decoricks-brown text-white'
                  : 'text-ink-secondary hover:bg-surface-sunken'
              }`}
            >
              {opt.label}
            </button>
          )
        })}
      </div>

      {period === 'custom' && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-ink-muted">
            <span className="sr-only">From date</span>
            <input
              type="date"
              value={customFrom}
              max={customTo || today}
              onChange={(e) => onCustomRange(e.target.value, customTo || e.target.value)}
              className="min-h-[36px] rounded-md border border-line px-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown"
            />
          </label>
          <span className="text-xs text-ink-muted" aria-hidden>
            →
          </span>
          <label className="flex items-center gap-1 text-xs text-ink-muted">
            <span className="sr-only">To date</span>
            <input
              type="date"
              value={customTo}
              min={customFrom || undefined}
              max={today}
              onChange={(e) => onCustomRange(customFrom || e.target.value, e.target.value)}
              className="min-h-[36px] rounded-md border border-line px-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown"
            />
          </label>
        </div>
      )}

      <Button
        variant="outline"
        size="sm"
        onClick={onRefresh}
        loading={refreshing}
        aria-label="Refresh dashboard"
        className="self-start sm:self-auto"
      >
        {!refreshing && <IconRefresh size={15} />}
        Refresh
      </Button>
    </div>
  )
}
