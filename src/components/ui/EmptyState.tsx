'use client'

import React, { useRef, useEffect } from 'react'
import { animations, cleanupAnimations } from '@/lib/animations'

interface EmptyStateProps {
  title: string
  description?: string
  action?: {
    label: string
    onClick: () => void
  }
  icon?: React.ReactNode
}

export const EmptyState = ({ title, description, action, icon }: EmptyStateProps) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const iconRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    const iconEl = iconRef.current
    if (!container) return

    // Animate container in
    animations.fadeInUp(container, 0.5, 0.1)

    // Animate icon with a delay
    if (iconEl) {
      animations.stateIconEnter(iconEl, 0.1)
    }

    return () => {
      cleanupAnimations(container)
      if (iconEl) cleanupAnimations(iconEl)
    }
  }, [])

  const defaultIcon = (
    <svg className="w-16 h-16 text-decoricks-dark/30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
    </svg>
  )

  return (
    <div ref={containerRef} className="flex flex-col items-center justify-center py-12 px-4 text-center">
      <div ref={iconRef} className="mb-4">
        {icon || defaultIcon}
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
