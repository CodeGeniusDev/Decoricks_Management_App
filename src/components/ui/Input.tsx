'use client'

import React, { useId } from 'react'

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, className = '', id, ...props }, ref) => {
    const generatedId = useId()
    const inputId = id || generatedId

    return (
      <div className="flex w-full flex-col gap-1.5">
        {label && (
          <label htmlFor={inputId} className="text-xs font-medium text-ink-secondary">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={`
            h-10 w-full rounded-md border bg-surface-raised px-3 text-sm text-ink-secondary
            transition-colors placeholder:text-ink-muted
            focus-visible:border-decoricks-brown focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown
            disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-muted
            ${error ? 'border-status-danger' : 'border-line'}
            ${className}
          `}
          aria-invalid={error ? true : undefined}
          {...props}
        />
        {error && (
          <p className="text-xs text-status-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    )
  }
)

Input.displayName = 'Input'