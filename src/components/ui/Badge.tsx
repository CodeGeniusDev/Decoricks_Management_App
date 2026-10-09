'use client'

import React from 'react'

interface BadgeProps {
  children: React.ReactNode
  variant?: 'default' | 'success' | 'warning' | 'error'
  size?: 'sm' | 'md'
  className?: string
}

/**
 * Badge — static status label. Pill shaped (as in the reference design) and
 * completely inert: no hover scale, no enter animation.
 */
export const Badge = ({
  children,
  variant = 'default',
  size = 'md',
  className = '',
}: BadgeProps) => {
  /*
   * Muted status pairs rather than saturated fills. A solid green/yellow/red chip
   * reads as an alarm every time it appears, so routine states such as "paid" or
   * "in stock" competed for attention with the things that genuinely need it.
   */
  const variantStyles = {
    default: 'bg-surface-sunken text-ink-secondary',
    success: 'bg-status-success-bg text-status-success',
    warning: 'bg-status-warning-bg text-status-warning',
    error: 'bg-status-danger-bg text-status-danger',
  }

  const sizeStyles = {
    sm: 'px-2 py-0.5 text-2xs',
    md: 'px-2.5 py-1 text-xs',
  }

  return (
    <span
      className={`inline-flex items-center rounded-full font-medium ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
    >
      {children}
    </span>
  )
}