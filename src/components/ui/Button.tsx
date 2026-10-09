'use client'

import React from 'react'
import Link from 'next/link'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  /** When set the component renders a next/link anchor styled as a button. */
  href?: string
  children: React.ReactNode
}

/**
 * Button — shared action control.
 *
 * Defaults to `type="button"
 ` so it can never accidentally submit an ancestor
 * form; pass `type="submit"` explicitly for real submissions. Hover feedback is
 * colour-only (matching the reference design), there is no scale/lift.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      loading = false,
      href,
      type = 'button',
      className = '',
      disabled,
      children,
      ...props
    },
    ref
  ) => {
    const baseStyles =
      'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown disabled:cursor-not-allowed disabled:opacity-50'

    /*
     * `outline` uses a 1px border, not 2px. A 2px ring around every secondary
     * action is the loudest possible treatment for a control that is meant to
     * recede, and it doubled the perceived border weight of every form.
     */
    const variantStyles = {
      primary:
        'bg-decoricks-brown text-decoricks-light hover:bg-decoricks-brown-dark focus-visible:ring-decoricks-brown',
      secondary:
        'bg-decoricks-dark text-decoricks-light hover:bg-decoricks-black focus-visible:ring-decoricks-dark',
      outline:
        'border border-line bg-surface-raised text-ink-secondary hover:bg-surface-sunken hover:text-ink focus-visible:ring-decoricks-brown',
      ghost: 'text-decoricks-brown hover:bg-decoricks-brown/10 focus-visible:ring-decoricks-brown',
    }

    /*
     * 36px for compact controls, 44px for anything that is a primary touch
     * target on a phone. Sizes are fixed heights so a row of mixed buttons
     * stays on one baseline.
     */
    const sizeStyles = {
      sm: 'h-9 px-3 text-xs',
      md: 'h-10 px-3.5 text-sm',
      lg: 'h-11 px-5 text-base',
    }

    const classes = `${baseStyles} ${variantStyles[variant]} ${sizeStyles[size]} ${className}`

    const content = loading ? (
      <span className="flex items-center gap-2">
        <svg
          className="animate-spin h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.14 5.824 3 7.938l3-2.647z"
          />
        </svg>
        {children}
      </span>
    ) : (
      children
    )

    // Anchor variant: use next/link so internal navigation stays client-side.
    // Rendered as a single anchor element, never as a button nested inside a link.
    if (href) {
      const { onClick, ...anchorRest } = props as React.ButtonHTMLAttributes<HTMLButtonElement>
      return (
        <Link
          href={href}
          className={classes}
          aria-disabled={disabled || undefined}
          data-loading={loading || undefined}
          onClick={onClick as unknown as React.MouseEventHandler<HTMLAnchorElement>}
          {...(anchorRest as Record<string, unknown>)}
        >
          {content}
        </Link>
      )
    }

    return (
      <button ref={ref} type={type} className={classes} disabled={disabled || loading} {...props}>
        {content}
      </button>
    )
  }
)

Button.displayName = 'Button'