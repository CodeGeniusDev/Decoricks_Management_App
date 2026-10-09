'use client'

import React from 'react'

interface SkeletonProps {
  className?: string
  variant?: 'text' | 'rect' | 'circle'
  width?: string
  height?: string
}

/**
 * Skeleton — loading placeholder.
 *
 * The pulse is a CSS animation instead of `animations.skeletonPulse`, which
 * created a GSAP tween per placeholder element. A list of 40 rows was therefore
 * running 40 JS tweens on the main thread just to shimmer, which competes with
 * the data arriving. CSS runs the same animation off the main thread for free.
 */
export const Skeleton = ({ className = '', variant = 'rect', width, height }: SkeletonProps) => {
  const variantStyles = {
    text: 'h-4 rounded-sm',
    rect: 'rounded-md',
    circle: 'rounded-full',
  }

  const style = {
    width: width || (variant === 'text' ? '100%' : undefined),
    height: height || (variant === 'text' ? '1rem' : undefined),
  }

  return (
    <div
      aria-hidden="true"
      className={`animate-pulse bg-surface-sunken ${variantStyles[variant]} ${className}`}
      style={style}
    />
  )
}