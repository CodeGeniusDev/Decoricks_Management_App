'use client'

import React from 'react'

interface TableProps {
  columns: Array<{ key: string; label: string }>
  data: Array<Record<string, React.ReactNode>>
  pagination?: {
    currentPage: number
    totalPages: number
    onPageChange: (page: number) => void
  }
  /** Supplying this makes rows genuinely interactive (hover + cursor allowed). */
  onRowClick?: (row: Record<string, React.ReactNode>, index: number) => void
  rowKey?: string
  className?: string
  /** Screen-reader description of the table, since it has no visible heading. */
  caption?: string
}

/**
 * Table — read-only data grid by default.
 *
 * Static rows have no hover styling at all; hover feedback is only enabled for
 * rows that are actually clickable via `onRowClick`.
 */
export const Table = ({
  columns,
  data,
  pagination,
  onRowClick,
  rowKey,
  className = '',
  caption = 'Data table',
}: TableProps) => {
  const isInteractive = typeof onRowClick === 'function'

  return (
    <div className={`overflow-x-auto ${className}`}>
      <table className="w-full min-w-full border-collapse text-left">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line-strong">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className="whitespace-nowrap bg-surface-sunken px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-ink-muted first:pl-4 last:pr-4"
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, rowIndex) => {
            const key =
              (rowKey && typeof row[rowKey] === 'string' ? String(row[rowKey]) : null) ??
              `${rowIndex}-${columns.map((c) => c.key).join('-')}`

            return (
              <tr
                key={key}
                onClick={isInteractive ? () => onRowClick(row, rowIndex) : undefined}
                onKeyDown={
                  isInteractive
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onRowClick(row, rowIndex)
                        }
                      }
                    : undefined
                }
                tabIndex={isInteractive ? 0 : undefined}
                className={`border-b border-line-subtle ${
                  isInteractive ? 'cursor-pointer transition-colors hover:bg-surface-sunken' : ''
                } ${isInteractive ? 'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-decoricks-brown' : ''}`}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className="px-3 py-2.5 align-middle text-sm text-ink-secondary first:pl-4 last:pr-4"
                  >
                    {row[column.key]}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>

      {pagination && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-3">
          <p className="text-xs text-ink-muted">
            Page {pagination.currentPage} of {Math.max(1, pagination.totalPages)}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => pagination.onPageChange(pagination.currentPage - 1)}
              disabled={pagination.currentPage === 1}
              className="h-8 rounded border border-line bg-surface-raised px-3 text-xs font-medium text-ink-secondary transition-colors hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => pagination.onPageChange(pagination.currentPage + 1)}
              disabled={pagination.currentPage >= pagination.totalPages}
              className="h-8 rounded border border-line bg-surface-raised px-3 text-xs font-medium text-ink-secondary transition-colors hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  )
}