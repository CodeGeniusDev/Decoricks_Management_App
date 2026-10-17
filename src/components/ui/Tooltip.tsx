'use client'

import React, { useId, useState } from 'react'

interface TooltipProps {
  content: string
  children: React.ReactElement
  position?: 'top' | 'bottom' | 'left' | 'right'
  /**
   * When the tooltip is only decoration for an icon-only control, the control
   * itself must still expose an accessible name. Pass the same string here.
   */
  disabled?: boolean
}

/**
 * Tooltip — CSS-only, no animation library.
 *
 * The previous implementation drove show/hide through GSAP promises, which meant
 * a tooltip could get stuck open if an exit animation was interrupted. This
 * version uses group-hover/focus-within, so it cannot desynchronise, and it opens
 * on keyboard focus as well as pointer hover.
 */
export const Tooltip = ({
  content,
  children,
  position = 'right',
  disabled = false,
}: TooltipProps) => {
  const [open, setOpen] = useState(false)
  const id = useId()

  if (disabled || !content) return children

  const positionClasses: Record<string, string> = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-1.5',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-1.5',
    left: 'right-full top-1/2 -translate-y-1/2 mr-1.5',
    right: 'left-full top-1/2 -translate-y-1/2 ml-1.5',
  }

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={() => setOpen(false)}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          id={id}
          className={`pointer-events-none absolute z-50 whitespace-nowrap rounded bg-decoricks-dark px-2 py-1 text-2xs font-medium text-white shadow-md ${positionClasses[position]}`}
        >
          {content}
        </span>
      )}
    </span>
  )
}
