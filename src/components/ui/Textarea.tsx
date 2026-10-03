'use client'

import React, { useRef, useEffect } from 'react'
import { animations, cleanupAnimations } from '@/lib/animations'

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  error?: string
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, className = '', id, ...props }, ref) => {
    const textareaId = id || `textarea-${Math.random().toString(36).substr(2, 9)}`
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
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown focus-visible:border-transparent
            disabled:opacity-50 disabled:pointer-events-none
            min-h-[44px]
            resize-vertical
            ${error ? 'border-red-500 focus-visible:ring-red-500' : 'border-decoricks-dark/30'}
            ${className}
          `}
          {...props}
        />
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    )
  }
)

Textarea.displayName = 'Textarea'
