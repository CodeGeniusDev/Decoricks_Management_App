'use client'

import React, { useRef, useEffect } from 'react'
import { animations, cleanupAnimations } from '@/lib/animations'

interface SkeletonProps {
  className?: string
  variant?: 'text' | 'rect' | 'circle'
  width?: string
  height?: string
}

export const Skeleton = ({ className = '', variant = 'rect', width, height }: SkeletonProps) => {
  const skeletonRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const skeleton = skeletonRef.current
    if (!skeleton) return

    // Apply pulse animation
    animations.skeletonPulse(skeleton)

    return () => {
      cleanupAnimations(skeleton)
    }
  }, [])

  const variantStyles = {
    text: 'h-4 rounded',
    rect: 'rounded-lg',
    circle: 'rounded-full',
  }

  const style = {
    width: width || (variant === 'text' ? '100%' : undefined),
    height: height || (variant === 'text' ? '1rem' : undefined),
  }

  return (
    <div
      ref={skeletonRef}
      className={`bg-decoricks-dark/20 ${variantStyles[variant]} ${className}`}
      style={style}
      aria-hidden="true"
    />
  )
}
