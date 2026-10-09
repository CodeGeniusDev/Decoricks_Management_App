'use client'

import React from 'react'

interface CardProps {
  children: React.ReactNode
  className?: string
  variant?: 'default' | 'dark'
  /**
   * Kept for API compatibility. Cards no longer animate themselves: a static
   * information card must stay visually identical while the pointer moves over
   * it, and GSAP transforms left inline on a remount caused visible jitter.
   */
  animate?: boolean
}

/**
 * Card — static surface for grouped content.
 *
 * Intentionally has no hover styles of any kind (no lift, scale, shadow or
 * colour change) and no enter animation. Interactive cards should be built from
 * a button/link so keyboard and focus behaviour stays correct.
 */
export const Card = ({ children, className = '', variant = 'default' }: CardProps) => {
  const baseStyles = 'rounded-lg border'

  const variantStyles = {
    // Opaque, hairline-bordered. A translucent surface over a busy page is
    // what made every panel look like frosted glass; cards now read as
    // surfaces, and elevation is expressed with the border alone.
    default: 'bg-surface-raised border-line-subtle text-ink',
    dark: 'bg-decoricks-dark border-decoricks-dark text-decoricks-light',
  }

  return (
    <div className={`${baseStyles} ${variantStyles[variant]} ${className}`}>{children}</div>
  )
}