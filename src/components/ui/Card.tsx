'use client'

import React, { useRef, useEffect } from 'react'
import { animations, cleanupAnimations } from '@/lib/animations'

interface CardProps {
  children: React.ReactNode
  className?: string
  variant?: 'default' | 'dark'
  animate?: boolean
}

export const Card = ({ children, className = '', variant = 'default', animate = true }: CardProps) => {
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!animate) return

    const card = cardRef.current
    if (!card) return

    // Initial fade in animation
    animations.scaleIn(card, 0.4, 0)

    const handleMouseEnter = () => animations.cardHover(card)
    const handleMouseLeave = () => animations.cardHoverOut(card)

    card.addEventListener('mouseenter', handleMouseEnter)
    card.addEventListener('mouseleave', handleMouseLeave)

    return () => {
      card.removeEventListener('mouseenter', handleMouseEnter)
      card.removeEventListener('mouseleave', handleMouseLeave)
      cleanupAnimations(card)
    }
  }, [animate])

  const baseStyles = 'rounded-xl shadow-glass border'
  const variantStyles = {
    default: 'glass bg-decoricks-light/70 border-decoricks-black/10',
    dark: 'glass-dark bg-decoricks-dark/80 border-decoricks-light/10 text-decoricks-light',
  }

  return (
    <div ref={cardRef} className={`${baseStyles} ${variantStyles[variant]} ${className}`}>
      {children}
    </div>
  )
}
