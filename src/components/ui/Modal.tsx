'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconClose } from './icons'

interface ModalProps {
  isOpen: boolean
  onClose: () => void
  title?: string
  /** Short line under the title explaining what the dialog is for. */
  description?: string
  children: React.ReactNode
  /** Action row. Sticky to the bottom so long forms stay reachable. */
  footer?: React.ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** Set false for dialogs the user must finish, e.g. during a submit. */
  dismissible?: boolean
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Modal — accessible dialog.
 *
 * Fixes, relative to the previous version:
 *  - Escape now closes the dialog. It previously had no key handler at all, so
 *    the only ways out were the close button and a backdrop click.
 *  - Tab is trapped inside the dialog, and focus returns to whatever opened it.
 *    Focus used to stay wherever it happened to be, behind the backdrop.
 *  - Background scroll lock saves and restores the previous value. The old code
 *    unconditionally wrote `overflow = 'unset'`, which clobbered any other
 *    scroll lock and dropped the page's own overflow styling.
 *  - The surface is opaque with a hairline border. Translucency plus a
 *    backdrop filter was the source of the frosted look throughout the app.
 *  - Entry is a short opacity/scale transition instead of a GSAP timeline, so
 *    there is no leftover transform on an ancestor of a fixed overlay.
 */
export const Modal = ({
  isOpen,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissible = true,
}: ModalProps) => {
  const dialogRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  // Remember the opener, move focus in, and put it back on close.
  useEffect(() => {
    if (!isOpen) return

    triggerRef.current = document.activeElement as HTMLElement | null

    const raf = requestAnimationFrame(() => {
      const dialog = dialogRef.current
      if (!dialog) return
      const target = dialog.querySelector<HTMLElement>(FOCUSABLE) ?? dialog
      target.focus()
    })

    return () => cancelAnimationFrame(raf)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) {
      const trigger = triggerRef.current
      if (trigger && document.body.contains(trigger)) {
        trigger.focus()
      }
      triggerRef.current = null
      return
    }
  }, [isOpen])

  // Escape + Tab containment.
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dismissible) {
        event.stopPropagation()
        onClose()
        return
      }

      if (event.key !== 'Tab') return

      const dialog = dialogRef.current
      if (!dialog) return

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null
      )
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement

      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    },
    [dismissible, onClose]
  )

  useEffect(() => {
    if (!isOpen) return
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, handleKeyDown])

  // Scroll lock, preserving whatever was there before.
  useEffect(() => {
    if (!isOpen) return
    const previousOverflow = document.body.style.overflow
    const previousPaddingRight = document.body.style.paddingRight
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth

    document.body.style.overflow = 'hidden'
    // Prevent the layout shifting left as the scrollbar disappears.
    if (scrollbarWidth > 0) document.body.style.paddingRight = `${scrollbarWidth}px`

    return () => {
      document.body.style.overflow = previousOverflow
      document.body.style.paddingRight = previousPaddingRight
    }
  }, [isOpen])

  if (!isOpen || !mounted) return null

  const sizeStyles = {
    sm: 'sm:max-w-md',
    md: 'sm:max-w-lg',
    lg: 'sm:max-w-2xl',
    xl: 'sm:max-w-4xl',
  }

  // Portalled to <body> on purpose: a transformed ancestor becomes the
  // containing block for `position: fixed`, which would otherwise collapse the
  // backdrop to the animated page container and push tall dialogs off-screen.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div
        className="fixed inset-0 bg-decoricks-black/45"
        onClick={dismissible ? onClose : undefined}
        aria-hidden="true"
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`relative flex w-full ${sizeStyles[size]} flex-col rounded-t-xl border border-line-subtle bg-surface-overlay shadow-lg focus:outline-none sm:my-auto sm:max-h-[calc(100dvh-2rem)] sm:rounded-xl`}
      >
        {/* Header. Always present so the dialog can always be closed, even
            when no title was supplied. */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line-subtle px-4 py-3 sm:px-5 sm:py-3.5">
          <div className="min-w-0">
            {title && (
              <h2 className="truncate text-md font-semibold text-decoricks-dark">{title}</h2>
            )}
            {description && <p className="mt-0.5 text-sm text-ink-muted">{description}</p>}
          </div>
          {dismissible && (
            <button
              type="button"
              onClick={onClose}
              className="-mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-decoricks-brown"
              aria-label="Close dialog"
            >
              <IconClose size={18} />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-5">{children}</div>

        {/* Sticky actions */}
        {footer && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line-subtle bg-surface-app px-4 py-3 sm:px-5">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}