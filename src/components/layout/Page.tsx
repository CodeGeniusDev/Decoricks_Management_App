import React from 'react'

/**
 * PageHeader — the title block every route shares.
 *
 * Pages previously each invented their own heading row (a bare <h1> with a
 * hand-tuned margin, sometimes duplicated with a second action cluster), which
 * is why vertical rhythm drifted between routes. This is the single pattern.
 */
interface PageHeaderProps {
  title: string
  /** Short, factual line under the title. Never marketing copy. */
  description?: string
  actions?: React.ReactNode
}

export const PageHeader = ({ title, description, actions }: PageHeaderProps) => (
  <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
    <div className="min-w-0">
      <h1 className="text-xl font-semibold tracking-tight text-decoricks-dark md:text-2xl">
        {title}
      </h1>
      {description && (
        <p className="mt-1 text-sm text-ink-muted">{description}</p>
      )}
    </div>
    {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
  </div>
)

/**
 * PageSection — a titled group of content with consistent vertical rhythm.
 *
 * Use for grouping inside a page. Deliberately *not* a card: sections should not
 * each add a border and shadow, which is what made the dashboard look like a
 * grid of AI template tiles.
 */
interface PageSectionProps {
  title?: string
  description?: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}

export const PageSection = ({
  title,
  description,
  actions,
  children,
  className = '',
}: PageSectionProps) => (
  <section className={className}>
    {(title || actions) && (
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          {title && (
            <h2 className="text-md font-semibold text-decoricks-dark">{title}</h2>
          )}
          {description && <p className="mt-0.5 text-sm text-ink-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    )}
    {children}
  </section>
)

/**
 * MetricGrid / Metric — compact metric blocks for the dashboard.
 *
 * Replaces the pattern where every figure sat in its own oversized card. These
 * read as a single scannable row with hairline separators.
 */
interface MetricProps {
  label: string
  value: string
  /** Optional supporting figure, e.g. a count or comparison. */
  hint?: string
  tone?: 'default' | 'positive' | 'negative'
}

const toneClasses: Record<NonNullable<MetricProps['tone']>, string> = {
  default: 'text-ink',
  positive: 'text-status-success',
  negative: 'text-status-danger',
}

export const Metric = ({ label, value, hint, tone = 'default' }: MetricProps) => (
  <div className="min-w-0 px-4 py-3.5">
    <p className="truncate text-xs font-medium text-ink-muted">{label}</p>
    <p className={`mt-1 truncate text-lg font-semibold tabular-nums ${toneClasses[tone]}`}>{value}</p>
    {hint && <p className="mt-0.5 truncate text-xs text-ink-muted">{hint}</p>}
  </div>
)

/** Responsive grid for Metric blocks. */
export const MetricGrid = ({ children }: { children: React.ReactNode }) => (
  <div className="grid grid-cols-2 divide-line-subtle overflow-hidden rounded-lg border border-line-subtle bg-surface-raised sm:grid-cols-2 lg:grid-cols-4 lg:divide-x">
    {children}
  </div>
)