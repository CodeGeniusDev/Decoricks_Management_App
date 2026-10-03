'use client'

import React, { useRef, useEffect } from 'react'
import { animations, cleanupAnimations } from '@/lib/animations'

interface BadgeProps {
  children: React.ReactNode
  variant?: 'default' | 'success' | 'warning' | 'error'
  size?: 'sm' | 'md'
  className?: string
}

export const Badge = ({ children, variant = 'default', size = 'md', className = '' }: BadgeProps) => {
  const badgeRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const badge = badgeRef.current
    if (!badge) return

    // Badge enter + hover
    animations.badgeEnter(badge, 0.05)

    const handleMouseEnter = () => animations.badgeHover(badge)
    const handleMouseLeave = () => animations.badgeHoverOut(badge)

    badge.addEventListener('mouseenter', handleMouseEnter)
    badge.addEventListener('mouseleave', handleMouseLeave)

    return () => {
      badge.removeEventListener('mouseenter', handleMouseEnter)
      badge.removeEventListener('mouseleave', handleMouseLeave)
      cleanupAnimations(badge)
    }
  }, [])

  const variantStyles = {
    default: 'bg-decoricks-dark text-decoricks-light',
    success: 'bg-green-500 text-white',
    warning: 'bg-yellow-500 text-white',
    error: 'bg-red-500 text-white',
  }

  const sizeStyles = {
    sm: 'px-2 py-0.5 text-xs',
    md: 'px-3 py-1 text-sm',
  }

  return (
    <span
      ref={badgeRef}
      className={`inline-flex items-center rounded-full font-medium ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
    >
      {children}
    </span>
  )
}
