'use client'

import React, { useId } from 'react'

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  error?: string
  options: Array<{ value: string; label: string }>
  /** Quiet helper text under the field. Hidden while `error` is showing. */
  hint?: string
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, error, hint, options, className = '', id, ...props }, ref) => {
    const generatedId = useId()
    const selectId = id || generatedId
    const describeId = hint || error ? `${selectId}-describe` : undefined

    return (
      <div className="flex w-full flex-col gap-1.5">
        {label && (
          <label htmlFor={selectId} className="text-xs font-medium text-ink-secondary">
            {label}
          </label>
        )}
        <select
          ref={ref}
          id={selectId}
          className={`
            h-11 min-h-[44px] w-full rounded-md border bg-surface-raised px-3 text-sm text-ink-secondary md:h-10
            transition-colors
            focus-visible:border-decoricks-brown focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown
            disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-muted
            ${error ? 'border-status-danger' : 'border-line'}
            ${className}
          `}
          aria-invalid={error ? true : undefined}
          aria-describedby={describeId}
          {...props}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {error ? (
          <p id={describeId} className="text-xs text-status-danger" role="alert">
            {error}
          </p>
        ) : (
          hint && (
            <p id={describeId} className="text-xs text-ink-muted">
              {hint}
            </p>
          )
        )}
      </div>
    )
  }
)

Select.displayName = 'Select'
