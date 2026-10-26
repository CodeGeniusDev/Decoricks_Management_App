/**
 * Floating-box placement — the shared math behind every portalled overlay
 * (tooltip, notification popover, account menu).
 *
 * Why this is a pure module instead of inline component code: the two overlays
 * that overflowed on a phone did so because their positioning rule was
 * unmeasurable. "Clamp to the viewport" (the previous rule) silently produces a
 * box whose far edge is off-screen when the box is WIDER than the viewport —
 * `Math.max(GAP, innerWidth - tw - GAP)` collapses to the edge padding and the
 * remaining 1000px simply hangs off the right side, unreachable because the box
 * ignores pointer events. That is invisible in a unit test and invisible in a
 * review; it is only visible as a number, so the rule is now a number-crunching
 * function with tests at 320px through 1440px.
 *
 * Two invariants the callers depend on:
 *
 *   1. FLIP BEFORE CLAMP. If the preferred side has no room, try the opposite,
 *      then the remaining sides. Clamping is the last resort, not the first
 *      move — a tooltip that jumps to the far edge of the screen is no longer
 *      describing the thing it belongs to.
 *   2. NEVER FURTHER THAN `edge` INSIDE THE VIEWPORT, provided the caller keeps
 *      the box itself inside the viewport (`max-w-[min(22rem,calc(100vw-…))]`).
 *      That precondition is why `maxBox` is exported here too: the bound and the
 *      placement are decided by the same file, so they cannot disagree.
 */

export type Placement = 'top' | 'bottom' | 'left' | 'right'

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export interface Viewport {
  width: number
  height: number
}

export interface Box {
  width: number
  height: number
}

/**
 * Where the box sits ALONG the trigger's edge. A tooltip describes the middle of
 * its control, so it centres. A dropdown belongs to the right-hand edge of the
 * button it came from, so it aligns there and the gap between bell and panel
 * never looks like a mistake.
 */
export type Align = 'center' | 'start' | 'end'

export interface Placed extends Box {
  left: number
  top: number
  /** The side the box ended up on, which may differ from the requested one. */
  placement: Placement
  flipped: boolean
  /**
   * False when the box could not be fully contained on any side, so it was
   * clamped: the caller can use this to enable scrolling or accept a crowded
   * fit rather than pretend the position is ideal.
   */
  contained: boolean
}

/** Default breathing room from the viewport edge, matching the design's 6px. */
export const DEFAULT_EDGE = 6

const OPPOSITE: Record<Placement, Placement> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
}

/** The order sides are tried in: requested, opposite, then the other two. */
const candidates = (preferred: Placement): Placement[] => {
  const rest = (['top', 'bottom', 'left', 'right'] as Placement[]).filter(
    (p) => p !== preferred && p !== OPPOSITE[preferred]
  )
  // Vertical sides are tried before horizontal ones: a wrapped tooltip is far
  // more often taller than wide, and a left/right anchor at 320px would leave it
  // almost no horizontal room next to its own trigger.
  const isVertical = (p: Placement): boolean => p === 'top' || p === 'bottom'
  return [
    preferred,
    OPPOSITE[preferred],
    ...rest.filter(isVertical),
    ...rest.filter((p) => !isVertical(p)),
  ]
}

/** Where the box would sit for one side, positioned along that side per `align`. */
const anchorFor = (
  placement: Placement,
  trigger: Rect,
  box: Box,
  gap: number,
  align: Align = 'center'
) => {
  const right = trigger.left + trigger.width
  const bottom = trigger.top + trigger.height
  // `align` moves the box ALONG the trigger's edge, so it applies to the axis
  // perpendicular to the placement direction — and it aligns EDGES, not centres:
  // `end` means the box's far edge meets the trigger's far edge, which is what
  // makes a dropdown look attached to the button it came from.
  const alongX = (start: number, end: number, centre: number) =>
    align === 'start' ? start : align === 'end' ? end - box.width : centre - box.width / 2
  const alongY = (start: number, end: number, centre: number) =>
    align === 'start' ? start : align === 'end' ? end - box.height : centre - box.height / 2

  switch (placement) {
    case 'top':
      return {
        left: alongX(trigger.left, right, trigger.left + trigger.width / 2),
        top: trigger.top - gap - box.height,
      }
    case 'bottom':
      return {
        left: alongX(trigger.left, right, trigger.left + trigger.width / 2),
        top: bottom + gap,
      }
    case 'left':
      return {
        left: trigger.left - gap - box.width,
        top: alongY(trigger.top, bottom, trigger.top + trigger.height / 2),
      }
    default:
      return {
        left: right + gap,
        top: alongY(trigger.top, bottom, trigger.top + trigger.height / 2),
      }
  }
}

const fits = (
  pos: { left: number; top: number },
  box: Box,
  viewport: Viewport,
  edge: number
): boolean =>
  pos.left >= edge &&
  pos.top >= edge &&
  pos.left + box.width <= viewport.width - edge &&
  pos.top + box.height <= viewport.height - edge

/**
 * The largest box that can still be placed inside `viewport` while keeping
 * `edge` clear on both axes. Callers feed this to CSS (`max-width`, `max-height`)
 * so a wide explanation wraps instead of extending past the screen.
 */
export const maxBox = (viewport: Viewport, edge = DEFAULT_EDGE): Box => ({
  width: Math.max(0, viewport.width - edge * 2),
  height: Math.max(0, viewport.height - edge * 2),
})

/**
 * Place a floating box next to `trigger`, inside `viewport`.
 *
 * `gap` separates the box from its trigger; `edge` is kept clear of the viewport
 * border. A box larger than the viewport cannot be contained — it is clamped to
 * the nearest legal origin (`contained: false`), which is the graceful
 * degradation for a genuinely enormous content string on a 320px screen.
 */
export const placeFloating = (
  trigger: Rect,
  box: Box,
  viewport: Viewport,
  options: { preferred?: Placement; gap?: number; edge?: number; align?: Align } = {}
): Placed => {
  const preferred = options.preferred ?? 'bottom'
  const gap = options.gap ?? 6
  const edge = options.edge ?? DEFAULT_EDGE
  const align = options.align ?? 'center'

  for (const placement of candidates(preferred)) {
    const pos = anchorFor(placement, trigger, box, gap, align)
    if (fits(pos, box, viewport, edge)) {
      return {
        left: Math.round(pos.left),
        top: Math.round(pos.top),
        width: box.width,
        height: box.height,
        placement,
        flipped: placement !== preferred,
        contained: true,
      }
    }
  }

  // Nothing fits anywhere: clamp the requested side's position so the box at
  // least starts inside the screen, and report that it is not contained.
  const pos = anchorFor(preferred, trigger, box, gap, align)
  const maxLeft = Math.max(edge, viewport.width - box.width - edge)
  const maxTop = Math.max(edge, viewport.height - box.height - edge)
  return {
    left: Math.round(Math.min(Math.max(edge, pos.left), maxLeft)),
    top: Math.round(Math.min(Math.max(edge, pos.top), maxTop)),
    width: box.width,
    height: box.height,
    placement: preferred,
    flipped: false,
    contained: false,
  }
}

/**
 * The vertical room left for a box anchored under `trigger`. Used to decide
 * whether content genuinely needs to scroll: a popover that fits entirely is
 * never given a scrollbar, and one that cannot be is capped to what is left
 * rather than measured against an arbitrary viewport fraction.
 */
export const roomBelow = (trigger: Rect, viewport: Viewport, gap: number, edge = DEFAULT_EDGE) =>
  Math.max(0, Math.round(viewport.height - (trigger.top + trigger.height + gap) - edge))
