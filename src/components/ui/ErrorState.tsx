'use client'

import React, { useRef, useEffect } from 'react'
import { animations, cleanupAnimations } from '@/lib/animations'

interface ErrorStateProps {
  title: string
  description?: string
  action?: {
    label: string
    onClick: () => void
  }
}

export const ErrorState = ({ title, description, action }: ErrorStateProps) => {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    animations.fadeInUp(container, 0.5, 0.1)

    return () => {
      cleanupAnimations(container)
    }
  }, [])

  return (
    <div ref={containerRef} className="flex flex-col items-center justify-center py-12 px-4 text-center">
      <div className="mb-4">
        <svg className="w-16 h-16 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      </div>
      <h3 className="text-lg font-semibold text-decoricks-dark mb-2">{title}</h3>
      {description && <p className="text-decoricks-dark/60 mb-6 max-w-sm">{description}</p>}
      {action && (
        <button
          onClick={action.onClick}
          className="px-4 py-2 bg-decoricks-brown text-decoricks-light rounded-lg hover:bg-decoricks-brown-dark transition-colors min-h-[44px]"
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
