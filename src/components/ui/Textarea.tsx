'use client'

import React, { useId } from 'react'

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  error?: string
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, className = '', id, ...props }, ref) => {
    const generatedId = useId()
    const textareaId = id || generatedId

    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label htmlFor={textareaId} className="text-sm font-medium text-decoricks-dark">
            {label}
          </label>
        )}
        <textarea
          ref={ref}
          id={textareaId}
          className={`
            px-4 py-2 rounded-lg border-2 bg-decoricks-light text-decoricks-black
            placeholder:text-decoricks-dark/50
            transition-colors
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown focus-visible:border-transparent
            disabled:opacity-50 disabled:pointer-events-none
            min-h-[44px]
            resize-vertical
            ${error ? 'border-red-500 focus-visible:ring-red-500' : 'border-decoricks-dark/30'}
            ${className}
          `}
          aria-invalid={error ? true : undefined}
          {...props}
        />
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    )
  }
)

Textarea.displayName = 'Textarea'