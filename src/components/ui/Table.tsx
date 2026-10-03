'use client'

import React, { useRef, useEffect } from 'react'
import { animations, cleanupAnimations } from '@/lib/animations'

interface TableProps {
  columns: Array<{ key: string; label: string }>
  data: Array<Record<string, React.ReactNode>>
  pagination?: {
    currentPage: number
    totalPages: number
    onPageChange: (page: number) => void
  }
  className?: string
}

export const Table = ({ columns, data, pagination, className = '' }: TableProps) => {
  const tableRef = useRef<HTMLTableElement>(null)

  useEffect(() => {
    const table = tableRef.current
    if (!table) return

    // Animate table rows on mount
    const rows = Array.from(table.querySelectorAll('tbody tr'))
    animations.staggerFadeIn(rows, 0.2, 0.05)

    // Add hover animations to rows
    const handleRowMouseEnter = (e: MouseEvent) => {
      const row = e.currentTarget as HTMLElement
      animations.tableRowHover(row)
    }

    const handleRowMouseLeave = (e: MouseEvent) => {
      const row = e.currentTarget as HTMLElement
      animations.tableRowHoverOut(row)
    }

    rows.forEach((row) => {
      row.addEventListener('mouseenter', handleRowMouseEnter)
      row.addEventListener('mouseleave', handleRowMouseLeave)
    })

    return () => {
      rows.forEach((row) => {
        row.removeEventListener('mouseenter', handleRowMouseEnter)
        row.removeEventListener('mouseleave', handleRowMouseLeave)
        cleanupAnimations(row)
      })
    }
  }, [data])

  return (
    <div className={`overflow-x-auto ${className}`}>
      <table ref={tableRef} className="w-full border-collapse">
        <thead>
          <tr className="border-b-2 border-decoricks-dark/20">
            {columns.map((column) => (
              <th
                key={column.key}
                className="px-4 py-3 text-left text-sm font-semibold text-decoricks-dark"
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-decoricks-dark/10">
              {columns.map((column) => (
                <td key={column.key} className="px-4 py-3 text-sm text-decoricks-dark">
                  {row[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {pagination && (
        <div className="flex items-center justify-between mt-4 px-4">
          <p className="text-sm text-decoricks-dark">
            Page {pagination.currentPage} of {pagination.totalPages}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => pagination.onPageChange(pagination.currentPage - 1)}
              disabled={pagination.currentPage === 1}
              className="px-3 py-1 rounded-lg border-2 border-decoricks-dark/30 text-decoricks-dark disabled:opacity-50 disabled:pointer-events-none min-h-[36px]"
            >
              Previous
            </button>
            <button
              onClick={() => pagination.onPageChange(pagination.currentPage + 1)}
              disabled={pagination.currentPage === pagination.totalPages}
              className="px-3 py-1 rounded-lg border-2 border-decoricks-dark/30 text-decoricks-dark disabled:opacity-50 disabled:pointer-events-none min-h-[36px]"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
