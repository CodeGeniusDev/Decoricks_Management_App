'use client'

import React, { useRef, useEffect } from 'react'
import { animations, cleanupAnimations } from '@/lib/animations'

interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ label, className = '', id, ...props }, ref) => {
    const checkboxId = id || `checkbox-${Math.random().toString(36).substr(2, 9)}`
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
      <div ref={wrapperRef} className="flex items-center gap-2">
        <input
          ref={ref}
          id={checkboxId}
          type="checkbox"
          className={`
            w-5 h-5 rounded border-2 border-decoricks-dark/30 bg-decoricks-light
            text-decoricks-brown focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown
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
