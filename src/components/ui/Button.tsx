'use client'

import React, { useRef, useEffect } from 'react'
import { animations, cleanupAnimations } from '@/lib/animations'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  children: React.ReactNode
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', children, className = '', onMouseEnter, onMouseLeave, ...props }, ref) => {
    const buttonRef = useRef<HTMLButtonElement>(null)

    useEffect(() => {
      const button = buttonRef.current
      if (!button) return

      const handleMouseEnter = (e: MouseEvent) => {
        animations.buttonHover(button)
        onMouseEnter?.(e)
      }

      const handleMouseLeave = (e: MouseEvent) => {
        animations.buttonHoverOut(button)
        onMouseLeave?.(e)
      }

      button.addEventListener('mouseenter', handleMouseEnter)
      button.addEventListener('mouseleave', handleMouseLeave)

      return () => {
        button.removeEventListener('mouseenter', handleMouseEnter)
        button.removeEventListener('mouseleave', handleMouseLeave)
        cleanupAnimations(button)
      }
    }, [onMouseEnter, onMouseLeave])

    const baseStyles =
      'inline-flex items-center justify-center font-medium rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none'

    const variantStyles = {
      primary:
        'bg-decoricks-brown text-decoricks-light hover:bg-decoricks-brown-dark focus-visible:ring-decoricks-brown',
      secondary:
        'bg-decoricks-dark text-decoricks-light hover:bg-decoricks-black focus-visible:ring-decoricks-dark',
      outline:
        'border-2 border-decoricks-brown text-decoricks-brown hover:bg-decoricks-brown hover:text-decoricks-light focus-visible:ring-decoricks-brown',
      ghost:
        'text-decoricks-brown hover:bg-decoricks-brown/10 focus-visible:ring-decoricks-brown',
    }

    const sizeStyles = {
      sm: 'px-3 py-1.5 text-sm min-h-[36px]',
      md: 'px-4 py-2 text-base min-h-[44px]',
      lg: 'px-6 py-3 text-lg min-h-[52px]',
    }

    return (
      <button
        ref={(node) => {
          buttonRef.current = node
          if (typeof ref === 'function') ref(node)
          else if (ref) ref.current = node
        }}
        className={`${baseStyles} ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
        {...props}
      >
        {children}
      </button>
    )
  }
)

Button.displayName = 'Button'
