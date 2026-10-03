'use client'

import React, { useState, useRef, useEffect } from 'react'
import { animations, cleanupAnimations } from '@/lib/animations'

interface TooltipProps {
  content: string
  children: React.ReactNode
  position?: 'top' | 'bottom' | 'left' | 'right'
}

export const Tooltip = ({ content, children, position = 'top' }: TooltipProps) => {
  const [isVisible, setIsVisible] = useState(false)
  const tooltipRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isVisible && tooltipRef.current) {
      animations.tooltipEnter(tooltipRef.current)
    }
  }, [isVisible])

  const positionStyles = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2',
  }

  const handleMouseLeave = () => {
    if (tooltipRef.current) {
      animations.tooltipExit(tooltipRef.current).then(() => setIsVisible(false))
    } else {
      setIsVisible(false)
    }
  }

  return (
    <div className="relative inline-block">
      <div
        onMouseEnter={() => setIsVisible(true)}
        onMouseLeave={handleMouseLeave}
        onFocus={() => setIsVisible(true)}
        onBlur={handleMouseLeave}
      >
        {children}
      </div>

      {isVisible && (
        <div
          ref={tooltipRef}
          className={`
            absolute z-50 px-3 py-1.5 text-sm text-white bg-decoricks-black rounded-lg shadow-glass
            whitespace-nowrap
            ${positionStyles[position]}
          `}
          role="tooltip"
        >
          {content}
        </div>
      )}
    </div>
  )
}
