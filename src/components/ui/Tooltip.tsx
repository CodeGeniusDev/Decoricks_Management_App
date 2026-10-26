'use client'

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { placeFloating, type Placement, type Placed } from '@/lib/ui/placement'

interface TooltipProps {
  content: string
  children: React.ReactElement
  position?: Placement
  /**
   * When the tooltip is only decoration for an icon-only control, the control
   * itself must still expose an accessible name. Pass the same string here.
   */
  disabled?: boolean
}

const GAP = 6
/** Kept clear of the viewport edge — the same value the CSS bound below uses. */
const EDGE = 8

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
 * sidebar label was invisible, which is the opposite of why it exists.
 *
 * WHAT CHANGED, and why the old version overflowed the screen. A dashboard
 * definition ("Operating expenses are every expense category except product
 * purchasing… · Source: computeProfitLoss.operatingLines + advertising slice
 * (SPEC §5.5)") is ~200 characters. The box carried `whitespace-nowrap`, so it
 * measured ~1386px wide at every viewport — the clamp then collapsed to the edge
 * padding and the box hung 1000+ pixels off the right-hand side of the screen,
 * unreachable because it ignored pointer events. So:
 *
 *   • the text WRAPS inside a viewport-bounded box (`max-w-[min(22rem,…)]`,
 *     never wider than the screen minus the edge), which is what makes
 *     containment possible at all;
 *   • placement FLIPS to the opposite side when the preferred one has no room
 *     (`placeFloating`) instead of sliding the box to a random edge, so the
 *     tooltip stays next to the thing it describes;
 *   • it opens on TAP as well as hover/focus and closes on Escape, a tap outside
 *     or a blur — a hover-only affordance is not an affordance on a phone, and
 *     these tooltips carry the financial definitions, not decoration;
 *   • it becomes scrollable (and therefore pointer-addressable) ONLY when the
 *     content genuinely does not fit the height that is left.
 *
 * Full text is never truncated — wrapping and scrolling are the only allowed
 * responses to a long explanation.
 */
export const Tooltip = ({
  content,
  children,
  position = 'right',
  disabled = false,
}: TooltipProps) => {
  const [open, setOpen] = useState(false)
  const [placed, setPlaced] = useState<Placed | null>(null)
  // True only when the tip is taller than the room available for it. A scrolling
  // tooltip has to accept pointer events, which a purely informational one must
  // not (it would sit between the user's cursor and the control).
  const [scrollable, setScrollable] = useState(false)
  const wrapRef = useRef<HTMLSpanElement | null>(null)
  const tipRef = useRef<HTMLSpanElement | null>(null)
  // Set when the tooltip was opened by a tap rather than a hover. Touch has no
  // hover state, so the close trigger has to be an explicit outside tap.
  const stickyRef = useRef(false)
  const id = useId()

  const measure = useCallback(() => {
    const trigger = wrapRef.current
    const tip = tipRef.current
    if (!trigger || !tip) return
    const r = trigger.getBoundingClientRect()
    const next = placeFloating(
      { left: r.left, top: r.top, width: r.width, height: r.height },
      { width: tip.offsetWidth, height: tip.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      { preferred: position, gap: GAP, edge: EDGE }
    )
    setPlaced(next)
    setScrollable(tip.scrollHeight > tip.clientHeight + 1)
  }, [position])

  // Reposition while the trigger moves under an open tooltip (rail or page
  // scroll, viewport resize). Capture is required — the scroll happens inside a
  // descendant container, not on window.
  useEffect(() => {
    if (!open) return
    const onUpdate = () => measure()
    window.addEventListener('scroll', onUpdate, true)
    window.addEventListener('resize', onUpdate)
    return () => {
      window.removeEventListener('scroll', onUpdate)
      window.removeEventListener('resize', onUpdate)
    }
  }, [open, measure])

  useLayoutEffect(() => {
    if (open) measure()
    else {
      setPlaced(null)
      setScrollable(false)
    }
  }, [open, measure])

  // Escape closes from anywhere, and an outside tap closes a tap-opened tooltip.
  // `mousedown` alone was the old popover's mistake: on a phone the reliable
  // signal is `pointerdown`.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        stickyRef.current = false
        setOpen(false)
      }
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (wrapRef.current?.contains(target) || tipRef.current?.contains(target)) return
      stickyRef.current = false
      setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open])

  if (disabled || !content) return children

  // A tooltip that only appears visually is not a description. While it is
  // open — including when focus or a tap opened it — the control is linked to it,
  // so a screen reader reads the explanation with the term rather than instead
  // of it.
  const described = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        'aria-describedby': open ? id : undefined,
      })
    : children

  if (typeof document === 'undefined') return <span ref={wrapRef}>{described}</span>

  const show = () => setOpen(true)
  const hide = () => {
    if (stickyRef.current) return
    setOpen(false)
  }

  return (
    <span
      ref={wrapRef}
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={show}
      onBlurCapture={() => {
        stickyRef.current = false
        setOpen(false)
      }}
      onPointerDown={(event) => {
        // Touch and pen get an explicit toggle. The default is not prevented, so
        // a tap on a real control still activates it.
        if (event.pointerType === 'mouse') return
        if (stickyRef.current) {
          stickyRef.current = false
          setOpen(false)
          return
        }
        stickyRef.current = true
        show()
      }}
    >
      {described}
      {open &&
        createPortal(
          <span
            ref={tipRef}
            role="tooltip"
            id={id}
            onMouseEnter={() => scrollable && show()}
            onMouseLeave={hide}
            className={`fixed z-[100] max-h-[min(50vh,24rem)] max-w-[min(22rem,calc(100vw-1rem))] overflow-y-auto overscroll-contain whitespace-normal break-words rounded bg-decoricks-dark px-2 py-1 text-2xs font-medium leading-relaxed text-white shadow-md ${
              scrollable ? 'pointer-events-auto' : 'pointer-events-none'
            } ${placed ? '' : 'invisible'}`}
            style={
              placed
                ? {
                    left: placed.left,
                    top: placed.top,
                    // Never let the box reach past the edge the placement was
                    // computed against, even if the font renders wider than
                    // measured (a late web-font load is enough to cause this).
                    maxWidth: `min(22rem, ${Math.max(80, placed.width)}px)`,
                  }
                : undefined
            }
          >
            {content}
          </span>,
          document.body
        )}
    </span>
  )
}
