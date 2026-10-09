'use client'

import React, { useEffect } from 'react'
import { IconAlert, IconCheck, IconClose } from './icons'

interface ToastProps {
  message: string
  type?: 'success' | 'error' | 'warning' | 'info'
  onClose?: () => void
  /** Auto-dismiss delay in ms. Pass 0 for a toast that requires acknowledgement. */
  duration?: number
}

/**
 * Toast — transient feedback.
 *
 * Entry is a CSS animation rather than a GSAP timeline: a JS timeline can be
 * interrupted mid-flight and leave a toast half-faded or stranded off-screen,
 * and it runs layout work on the main thread for something that only ever
 * translates a few pixels.
 *
 * The close button is the first focusable element and the toast announces itself
 * as a status, so a screen reader hears the result of the action that triggered it.
 */
export const Toast = ({ message, type = 'info', onClose, duration = 5000 }: ToastProps) => {
  useEffect(() => {
    if (!onClose || duration <= 0) return
    const timer = window.setTimeout(onClose, duration)
    return () => window.clearTimeout(timer)
  }, [onClose, duration])

  const typeStyles = {
    success: 'border-status-success/30 bg-status-success-bg text-status-success',
    error: 'border-status-danger/30 bg-status-danger-bg text-status-danger',
    warning: 'border-status-warning/30 bg-status-warning-bg text-status-warning',
    info: 'border-status-info/30 bg-status-info-bg text-status-info',
  }

  const Glyph = type === 'success' ? IconCheck : IconAlert

  return (
    <div
      role="status"
      aria-live="polite"
      className={`toast-enter flex items-start gap-2.5 rounded-lg border px-3 py-2.5 shadow-md ${typeStyles[type]}`}
    >
      <Glyph size={16} className="mt-0.5 shrink-0" />
      <span className="flex-1 text-sm font-medium">{message}</span>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="-mr-1 -mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-current"
          aria-label="Dismiss notification"
        >
          <IconClose size={14} />
        </button>
      )}
    </div>
  )
}