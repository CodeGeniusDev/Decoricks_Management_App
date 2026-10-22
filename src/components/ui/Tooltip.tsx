'use client'

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

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

const GAP = 6

type Coords = { left: number; top: number } | null

/**
 * Tooltip — no animation library, rendered in a portal.
 *
 * The previous implementation drove show/hide through GSAP promises, which meant
 * a tooltip could get stuck open if an exit animation was interrupted. This
 * version opens on keyboard focus as well as pointer hover.
 *
 * It is portalled and positioned with `fixed` coordinates instead of being an
 * `absolute` child of the trigger. That is not cosmetic: the desktop nav rail is
 * a scroll container, so an in-flow tooltip was clipped by it — every collapsed
 * sidebar label was invisible, which is the opposite of why it exists. Measuring
 * the trigger and clamping to the viewport also keeps tooltips on screen at 320px
 * and inside modals that clip their own content.
 */
export const Tooltip = ({
  content,
  children,
  position = 'right',
  disabled = false,
}: TooltipProps) => {
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<Coords>(null)
  const wrapRef = useRef<HTMLSpanElement | null>(null)
  const tipRef = useRef<HTMLSpanElement | null>(null)
  const id = useId()

  const place = useCallback(() => {
    const trigger = wrapRef.current
    const tip = tipRef.current
    if (!trigger || !tip) return

    const r = trigger.getBoundingClientRect()
    const tw = tip.offsetWidth
    const th = tip.offsetHeight

    let left = r.left
    let top = r.top
    if (position === 'right') {
      left = r.right + GAP
      top = r.top + r.height / 2 - th / 2
    } else if (position === 'left') {
      left = r.left - GAP - tw
      top = r.top + r.height / 2 - th / 2
    } else if (position === 'top') {
      left = r.left + r.width / 2 - tw / 2
      top = r.top - GAP - th
    } else {
      left = r.left + r.width / 2 - tw / 2
      top = r.bottom + GAP
    }

    // Clamp rather than flip: a tooltip that overflows on one axis at 320px
    // should still be readable, not jump under the control it describes.
    const maxLeft = Math.max(GAP, window.innerWidth - tw - GAP)
    const maxTop = Math.max(GAP, window.innerHeight - th - GAP)
    setCoords({
      left: Math.min(Math.max(GAP, left), maxLeft),
      top: Math.min(Math.max(GAP, top), maxTop),
    })
  }, [position])

  // Reposition while the trigger moves under an open tooltip (rail or page
  // scroll, viewport resize). Capture is required — the scroll happens inside a
  // descendant container, not on window.
  useEffect(() => {
    if (!open) return
    const onUpdate = () => place()
    window.addEventListener('scroll', onUpdate, true)
    window.addEventListener('resize', onUpdate)
    return () => {
      window.removeEventListener('scroll', onUpdate)
      window.removeEventListener('resize', onUpdate)
    }
  }, [open, place])

  useLayoutEffect(() => {
    if (open) place()
    else setCoords(null)
  }, [open, place])

  if (disabled || !content) return children

  // A tooltip that only appears visually is not a description. While it is
  // open — including when focus is what opened it — the control is linked to it,
  // so a screen reader reads the explanation with the term rather than instead
  // of it.
  const described = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        'aria-describedby': open ? id : undefined,
      })
    : children

  if (typeof document === 'undefined') return <span ref={wrapRef}>{described}</span>

  return (
    <span
      ref={wrapRef}
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={() => setOpen(false)}
    >
      {described}
      {open &&
        createPortal(
          <span
            ref={tipRef}
            role="tooltip"
            id={id}
            className={`pointer-events-none fixed z-[100] whitespace-nowrap rounded bg-decoricks-dark px-2 py-1 text-2xs font-medium text-white shadow-md ${
              coords ? '' : 'invisible'
            }`}
            style={coords ? { left: coords.left, top: coords.top } : undefined}
          >
            {content}
          </span>,
          document.body
        )}
    </span>
  )
}
