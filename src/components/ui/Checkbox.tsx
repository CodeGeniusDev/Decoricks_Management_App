'use client'

import React, { useId } from 'react'

interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ label, className = '', id, ...props }, ref) => {
    const generatedId = useId()
    const checkboxId = id || generatedId

    return (
      <div className="flex items-center gap-2">
        <input
          ref={ref}
          id={checkboxId}
          type="checkbox"
          className={`
            w-5 h-5 rounded border-2 border-decoricks-dark/30 bg-decoricks-light
            text-decoricks-brown transition-colors
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown
            focus-visible:ring-offset-2
            disabled:opacity-50 disabled:pointer-events-none
            cursor-pointer
            ${className}
          `}
          {...props}
        />
        {label && (
          <label htmlFor={checkboxId} className="text-sm font-medium text-decoricks-dark cursor-pointer">
            {label}
          </label>
        )}
      </div>
    )
  }
)

Checkbox.displayName = 'Checkbox'