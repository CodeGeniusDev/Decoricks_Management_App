'use client'

import React from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'

/**
 * PeriodFilter — the day / week / month / custom Karachi selector shared by
 * the P&L and Cash Flow screens (Phase 4 brief item 3). All values are plain
 * controlled strings that start empty, so server and client render
 * identically; an empty date means "the current period" on the server, which
 * anchors ranges in Asia/Karachi and never in the viewer's timezone.
 */

export type ReportPeriod = 'day' | 'week' | 'month' | 'custom'

export interface PeriodFilterValue {
  period: ReportPeriod
  /** 'YYYY-MM-DD' Karachi anchor for day/week/month; '' = current. */
  date: string
  from: string
  to: string
}

export const EMPTY_PERIOD_FILTER: PeriodFilterValue = {
  period: 'month',
  date: '',
  from: '',
  to: '',
}

/** Build the query string the /finance/pl and /finance/cash-flow routes accept. */
export const periodFilterQuery = (filter: PeriodFilterValue): string => {
  const params = new URLSearchParams({ period: filter.period })
  if (filter.period === 'custom') {
    if (filter.from) params.set('from', filter.from)
    if (filter.to) params.set('to', filter.to)
  } else if (filter.date) {
    params.set('date', filter.date)
  }
  return params.toString()
}

/** A custom range only becomes a request once both dates exist and are ordered. */
export const periodFilterReady = (filter: PeriodFilterValue): boolean => {
  if (filter.period !== 'custom') return true
  return Boolean(filter.from && filter.to && filter.from <= filter.to)
}

interface PeriodFilterProps {
  value: PeriodFilterValue
  onChange: (next: PeriodFilterValue) => void
  busy?: boolean
}

export const PeriodFilter = ({ value, onChange, busy = false }: PeriodFilterProps) => (
  <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
    <div className="sm:w-40">
      <Select
        label="Period"
        value={value.period}
        disabled={busy}
        onChange={(event) =>
          onChange({ ...value, period: event.target.value as ReportPeriod })
        }
        options={[
          { value: 'day', label: 'Day' },
          { value: 'week', label: 'Week (Mon–Sun)' },
          { value: 'month', label: 'Month' },
          { value: 'custom', label: 'Custom range' },
        ]}
      />
    </div>
    {value.period !== 'custom' ? (
      <div className="sm:w-44">
        <Input
          label="Date (Karachi)"
          type="date"
          value={value.date}
          disabled={busy}
          onChange={(event) => onChange({ ...value, date: event.target.value })}
        />
      </div>
    ) : (
      <>
        <div className="sm:w-44">
          <Input
            label="From"
            type="date"
            value={value.from}
            disabled={busy}
            onChange={(event) => onChange({ ...value, from: event.target.value })}
          />
        </div>
        <div className="sm:w-44">
          <Input
            label="To"
            type="date"
            value={value.to}
            min={value.from || undefined}
            disabled={busy}
            onChange={(event) => onChange({ ...value, to: event.target.value })}
          />
        </div>
      </>
    )}
    {value.period !== 'custom' && (
      <Button
        variant="outline"
        onClick={() => onChange({ ...EMPTY_PERIOD_FILTER, period: value.period })}
        disabled={busy}
      >
        Current
      </Button>
    )}
  </div>
)
