'use client'

import React, { useRef, useEffect } from 'react'
import { animations, cleanupAnimations } from '@/lib/animations'

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  error?: string
  options: Array<{ value: string; label: string }>
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, error, options, className = '', id, ...props }, ref) => {
    const selectId = id || `select-${Math.random().toString(36).substr(2, 9)}`
    const wrapperRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
      const wrapper = wrapperRef.current
      if (!wrapper) return

      const handleFocusIn = () => {
        animations.inputFocus(wrapper)
      }
      const handleFocusOut = () => {
        animations.inputFocusOut(wrapper)
      }

      wrapper.addEventListener('focusin', handleFocusIn)
      wrapper.addEventListener('focusout', handleFocusOut)

      return () => {
        wrapper.removeEventListener('focusin', handleFocusIn)
        wrapper.removeEventListener('focusout', handleFocusOut)
        cleanupAnimations(wrapper)
      }
    }, [])

    return (
      <div ref={wrapperRef} className="flex flex-col gap-1">
        {label && (
          <label htmlFor={selectId} className="text-sm font-medium text-decoricks-dark">
            {label}
          </label>
        )}
        <select
          ref={ref}
          id={selectId}
          className={`
            px-4 py-2 rounded-lg border-2 bg-decoricks-light text-decoricks-black
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown focus-visible:border-transparent
            disabled:opacity-50 disabled:pointer-events-none
            min-h-[44px]
            ${error ? 'border-red-500 focus-visible:ring-red-500' : 'border-decoricks-dark/30'}
            ${className}
          `}
          {...props}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    )
  }
)

Select.displayName = 'Select'
