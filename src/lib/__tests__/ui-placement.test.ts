import { describe, it, expect } from 'vitest'

import {
  placeFloating,
  maxBox,
  roomBelow,
  DEFAULT_EDGE,
  type Placement,
  type Rect,
  type Viewport,
} from '@/lib/ui/placement'

/**
 * Floating-box placement, tested as arithmetic.
 *
 * The dashboard's `i` tooltips were 1386px wide at every viewport because the box
 * carried `white-space: nowrap`, and the old clamp
 * `Math.max(GAP, innerWidth - tw - GAP)` collapses to the edge padding once the
 * box is WIDER than the viewport — so at 320px the tooltip was pinned at x=6 with
 * 1072px of it hanging off the right-hand side, unreachable because it ignored
 * pointer events. None of that is visible in a code review; all of it is visible
 * as a number, which is why the rule lives in a pure module.
 *
 * The contract asserted below is the two-part one the components rely on: the
 * CALLER bounds the box (`maxBox`, applied as CSS `max-width`), and this file
 * places the bounded box. Neither half is sufficient alone, which is exactly the
 * mistake the original tooltip made.
 */

// The seven widths the brief requires, each at a plausible height for that device.
const VIEWPORTS: { name: string; viewport: Viewport }[] = [
  { name: '320', viewport: { width: 320, height: 568 } },
  { name: '360', viewport: { width: 360, height: 640 } },
  { name: '390', viewport: { width: 390, height: 844 } },
  { name: '430', viewport: { width: 430, height: 932 } },
  { name: '768', viewport: { width: 768, height: 1024 } },
  { name: '1024', viewport: { width: 1024, height: 768 } },
  { name: '1440', viewport: { width: 1440, height: 900 } },
]

const triggerAt = (left: number, top: number, width = 24, height = 24): Rect => ({
  left,
  top,
  width,
  height,
})

const SIDES: Placement[] = ['top', 'bottom', 'left', 'right']

describe('maxBox — the CSS bound that makes containment possible', () => {
  it.each(VIEWPORTS)('$name px: a box can never be wider than the screen', ({ viewport }) => {
    const box = maxBox(viewport)
    expect(box.width).toBe(viewport.width - DEFAULT_EDGE * 2)
    expect(box.height).toBe(viewport.height - DEFAULT_EDGE * 2)
    // The rule that prevents the 1386px failure: the bound shrinks with the
    // viewport, so a long financial definition WRAPS instead of extending.
    expect(box.width).toBeLessThan(viewport.width)
  })

  it('never returns a negative box on an absurd viewport', () => {
    expect(maxBox({ width: 4, height: 4 })).toEqual({ width: 0, height: 0 })
  })
})

describe('placeFloating — the viewport containment guarantee', () => {
  /*
   * Every combination of viewport width, trigger position and requested side, with
   * the box bounded the way the components bound it. The assertion is the one the
   * brief asks for: the box is never partly off-screen, in any direction, at any
   * of the seven widths — including the case where NO side fits and the box has
   * to be clamped.
   */
  it.each(VIEWPORTS)('keeps a bounded tooltip on screen at $name px', ({ viewport }) => {
    const bounded = { width: Math.min(300, maxBox(viewport).width), height: 90 }
    const positions = [0, viewport.width / 2, viewport.width - 24]

    for (const left of positions) {
      for (const preferred of SIDES) {
        const placed = placeFloating(triggerAt(left, 120), bounded, viewport, {
          preferred,
          edge: DEFAULT_EDGE,
        })
        expect(placed.left).toBeGreaterThanOrEqual(0)
        expect(placed.top).toBeGreaterThanOrEqual(0)
        expect(placed.left + placed.width).toBeLessThanOrEqual(viewport.width)
        expect(placed.top + placed.height).toBeLessThanOrEqual(viewport.height)
      }
    }
  })

  it('keeps the edge clear when it can genuinely contain the box', () => {
    for (const { viewport } of VIEWPORTS) {
      const bounded = { width: Math.min(240, maxBox(viewport).width), height: 80 }
      const placed = placeFloating(triggerAt(viewport.width / 2, 300), bounded, viewport, {
        preferred: 'top',
      })
      expect(placed.contained).toBe(true)
      expect(placed.left).toBeGreaterThanOrEqual(DEFAULT_EDGE)
      expect(placed.top).toBeGreaterThanOrEqual(DEFAULT_EDGE)
      expect(placed.left + placed.width).toBeLessThanOrEqual(viewport.width - DEFAULT_EDGE)
      expect(placed.top + placed.height).toBeLessThanOrEqual(viewport.height - DEFAULT_EDGE)
    }
  })

  it('flips to the opposite side rather than sliding away from its trigger', () => {
    const viewport = { width: 1024, height: 768 }
    // A trigger near the top of the screen has no room above it.
    const placed = placeFloating(triggerAt(500, 12), { width: 300, height: 90 }, viewport, {
      preferred: 'top',
    })
    expect(placed.placement).toBe('bottom')
    expect(placed.flipped).toBe(true)
    // Flip, not flee: the box stays centred on the trigger that owns it, so it is
    // still visibly describing the right metric.
    expect(placed.left + placed.width / 2).toBeCloseTo(500 + 24 / 2, 0)
  })

  it('tries the vertical axis before the horizontal one', () => {
    const viewport = { width: 320, height: 844 }
    // A 200px box has no room beside a trigger at x=160 on a 320px screen, so a
    // wrapped tooltip (far more often tall than wide) must be offered top/bottom
    // first or it gets clamped when a clean fit existed.
    const placed = placeFloating(triggerAt(160, 400), { width: 200, height: 90 }, viewport, {
      preferred: 'left',
    })
    expect(placed.placement).toBe('top')
    expect(placed.contained).toBe(true)
  })

  it('keeps the requested side when it fits, so nothing moves for no reason', () => {
    const viewport = { width: 1440, height: 900 }
    const placed = placeFloating(triggerAt(700, 400), { width: 300, height: 90 }, viewport, {
      preferred: 'right',
    })
    expect(placed.placement).toBe('right')
    expect(placed.flipped).toBe(false)
    expect(placed.left).toBe(700 + 24 + 6)
    expect(placed.top).toBe(400 + 24 / 2 - 90 / 2)
  })

  it('flips above a trigger that has no room below it', () => {
    const viewport = { width: 1024, height: 768 }
    const placed = placeFloating(triggerAt(500, 730), { width: 300, height: 90 }, viewport, {
      preferred: 'bottom',
    })
    expect(placed.placement).toBe('top')
    expect(placed.flipped).toBe(true)
    expect(placed.contained).toBe(true)
    expect(placed.top + placed.height).toBeLessThanOrEqual(viewport.height - DEFAULT_EDGE)
  })

  it('pulls a clamped box back on screen when no side fits at all', () => {
    // A trigger hard against the bottom edge AND the left edge: neither side can
    // host a 300px box, so the box is clamped — and a clamp is not a lie, it
    // still lands fully inside the viewport with the edge clear.
    const viewport = { width: 390, height: 844 }
    const placed = placeFloating(
      triggerAt(60, viewport.height - 30),
      { width: 300, height: 90 },
      viewport,
      {
        preferred: 'bottom',
      }
    )
    expect(placed.contained).toBe(false)
    expect(placed.top + placed.height).toBeLessThanOrEqual(viewport.height - DEFAULT_EDGE)
    expect(placed.left).toBeGreaterThanOrEqual(DEFAULT_EDGE)
    expect(placed.left + placed.width).toBeLessThanOrEqual(viewport.width - DEFAULT_EDGE)
  })

  it('honours a custom edge and gap', () => {
    const viewport = { width: 100, height: 100 }
    const placed = placeFloating(triggerAt(40, 40), { width: 20, height: 20 }, viewport, {
      preferred: 'top',
      gap: 4,
      edge: 2,
    })
    expect(placed.contained).toBe(true)
    expect(placed.top + placed.height).toBe(40 - 4)
  })
})

describe('placeFloating — the clamp cannot rescue an unbounded box, and says so', () => {
  it('reports contained:false for the exact geometry that overflowed in production', () => {
    const viewport = { width: 320, height: 844 }
    // The non-wrapping dashboard definition, measured in Chromium at 1386px wide.
    const nowrap = { width: 1386, height: 58 }
    const placed = placeFloating(triggerAt(160, 120), nowrap, viewport, { preferred: 'top' })

    expect(placed.contained).toBe(false)
    // The origin is still the edge… which is precisely the behaviour that LOOKED
    // like a fix and was not: the box simply extends past the screen.
    expect(placed.left).toBe(DEFAULT_EDGE)
    expect(placed.left + placed.width).toBeGreaterThan(viewport.width)
  })

  it('is fixed by wrapping the same content into a bounded box', () => {
    const viewport = { width: 320, height: 844 }
    // The identical definition, wrapped: the whole overflow was a CSS problem
    // that the placement code was hiding. There is no room above a trigger at
    // y=120 for 160px of text, so it flips below and is contained.
    const wrapped = { width: 260, height: 160 }
    const placed = placeFloating(triggerAt(160, 120), wrapped, viewport, { preferred: 'top' })

    expect(placed.placement).toBe('bottom')
    expect(placed.contained).toBe(true)
    expect(placed.left + placed.width).toBeLessThanOrEqual(viewport.width - DEFAULT_EDGE)
  })

  it('still keeps a full-bleed box on screen when the bound leaves no slack', () => {
    const viewport = { width: 320, height: 844 }
    // A box at exactly the maximum width can only ever sit at one x on a 320px
    // screen, so "contained" is impossible for an off-centre trigger. The honest
    // answer is to report it and stay on screen, not to pretend the anchor worked.
    const fullBleed = { width: maxBox(viewport).width, height: 160 }
    const placed = placeFloating(triggerAt(160, 120), fullBleed, viewport, { preferred: 'bottom' })

    expect(placed.contained).toBe(false)
    expect(placed.left).toBe(DEFAULT_EDGE)
    expect(placed.left + placed.width).toBeLessThanOrEqual(viewport.width)
  })
})

describe('align — a dropdown belongs to an edge, not to the middle', () => {
  it('right-aligns a panel with the bell that opened it', () => {
    const viewport = { width: 1024, height: 768 }
    const trigger = triggerAt(900, 8, 44, 44)
    const placed = placeFloating(trigger, { width: 352, height: 400 }, viewport, {
      preferred: 'bottom',
      align: 'end',
      gap: 8,
    })
    expect(placed.left).toBe(900 + 44 - 352)
    expect(placed.top).toBe(8 + 44 + 8)
    expect(placed.contained).toBe(true)
  })

  it('left-aligns when asked', () => {
    const viewport = { width: 1024, height: 768 }
    const placed = placeFloating(triggerAt(100, 8, 44, 44), { width: 352, height: 400 }, viewport, {
      preferred: 'bottom',
      align: 'start',
    })
    expect(placed.left).toBe(100)
    expect(placed.contained).toBe(true)
  })

  it('clamps an end-aligned panel at 320px instead of hanging it off the left', () => {
    // The measured notification-popover failure: `absolute right-0` anchored to a
    // bell that is ~70px from the screen edge put the panel's LEFT edge at -44px,
    // so the title was permanently off-screen. A bounded box plus this clamp puts
    // it at the edge instead.
    const viewport = { width: 320, height: 844 }
    const bell = triggerAt(216, 8, 44, 44)
    const panel = { width: maxBox(viewport, 8).width, height: 400 }
    const placed = placeFloating(bell, panel, viewport, {
      preferred: 'bottom',
      align: 'end',
      edge: 8,
    })
    expect(placed.left).toBe(8)
    expect(placed.left + placed.width).toBeLessThanOrEqual(viewport.width)
    expect(placed.contained).toBe(false)
    // And the naive `right-0` anchoring it replaces really was off screen:
    expect(bell.left + bell.width - panel.width).toBeLessThan(0)
  })
})

describe('roomBelow — scrolling only when it is genuinely needed', () => {
  it('measures the space under the trigger down to the edge', () => {
    const viewport = { width: 390, height: 844 }
    // The header is 60px tall (`h-header`) and the bell sits inside it; the panel
    // is anchored under the bell.
    const trigger = triggerAt(300, 18, 44, 44)
    expect(roomBelow(trigger, viewport, 8)).toBe(844 - (18 + 44 + 8) - DEFAULT_EDGE)
  })

  it('never returns a negative height for a trigger that is off-screen', () => {
    expect(roomBelow(triggerAt(0, 1000, 44, 44), { width: 390, height: 844 }, 8)).toBe(0)
  })

  it('shrinks as the trigger moves down instead of guessing a viewport fraction', () => {
    const viewport = { width: 390, height: 844 }
    const high = roomBelow(triggerAt(0, 20, 44, 44), viewport, 8)
    const low = roomBelow(triggerAt(0, 300, 44, 44), viewport, 8)
    expect(high).toBeGreaterThan(low)
    expect(high - low).toBe(280)
  })
})

describe('the notification panel, at the widths the brief names', () => {
  /*
   * This is `NotificationBell.measure()` reproduced line for line — same constants
   * (PANEL_EDGE 8, PANEL_GAP 8, PANEL_WIDTH 352), same trigger model — so the
   * component and this file cannot drift apart silently.
   *
   * The trigger model is derived from production, not assumed. The old panel was
   * `absolute right-0` on the bell and measured at left = -44px at 320, -41 at 360
   * and -32 at 390. Solving `bell.right - min(0.92 * W, 352)` against those three
   * numbers gives `bell.right = W - 70` exactly, because the bell is followed by
   * the account button inside a `gap-3 px-4` cluster. That is the geometry used
   * below: the same rect that produced the bug, given the new arithmetic.
   *
   * `W - 70` is verified on the PHONE path only, which is where the reported bug
   * lived. A headless-Chromium pass over the real header markup measured the bell's
   * right edge at exactly W−70 for 320/360/390/430, and further in from `sm` onward
   * (W−115 at 680, W−123 at 768, 1024 and 1440), because from `sm` the account
   * button gains its name label and from `md` the header row switches `px-4` →
   * `px-6`. So the trigger below is a faithful reproduction of the failing case and
   * a property test of the desktop case, not a claim about the desktop pixel
   * geometry. What is invariant across both is the assertion this file makes: the
   * panel is inside the screen.
   */
  const PANEL_EDGE = 8
  const PANEL_GAP = 8
  const PANEL_WIDTH = 352

  const bellFor = (width: number): Rect => triggerAt(width - 70 - 44, 8, 44, 44)

  const measureAsTheBellDoes = (viewport: Viewport) => {
    const trigger = bellFor(viewport.width)
    const available = maxBox(viewport, PANEL_EDGE)
    const boxWidth = Math.min(PANEL_WIDTH, available.width)
    const maxHeight = roomBelow(trigger, viewport, PANEL_GAP, PANEL_EDGE)
    const placed = placeFloating(trigger, { width: boxWidth, height: maxHeight }, viewport, {
      preferred: 'bottom',
      align: 'end',
      gap: PANEL_GAP,
      edge: PANEL_EDGE,
    })
    return { placed, boxWidth, maxHeight }
  }

  /** The width the panel HAD, for the same trigger — the shipping failure. */
  const oldLeftEdge = (viewport: Viewport) => {
    const right = viewport.width - 70
    return right - Math.min(0.92 * viewport.width, PANEL_WIDTH)
  }

  it.each(VIEWPORTS)('$name px: the panel is inside the screen, all four sides', (v) => {
    const { placed, boxWidth, maxHeight } = measureAsTheBellDoes(v.viewport)

    if (v.viewport.width < 430) {
      // Reproduce the report as a number: below 430px the title was outside the
      // screen. At 430 the old panel already fitted (left = +8), which is exactly
      // why the bug read as "phones only" and survived a desktop review.
      expect(oldLeftEdge(v.viewport)).toBeLessThan(0)
    }

    // The requirement: completely inside the viewport, on all four sides.
    expect(placed.left).toBeGreaterThanOrEqual(PANEL_EDGE)
    expect(placed.top).toBeGreaterThanOrEqual(0)
    expect(placed.left + boxWidth).toBeLessThanOrEqual(v.viewport.width - PANEL_EDGE)
    expect(placed.top + maxHeight).toBeLessThanOrEqual(v.viewport.height)
  })

  /*
   * The one honest limit of anchoring, stated as a test rather than hidden.
   * A right-aligned panel of width `b` needs `bell.right - b >= edge`, i.e.
   * `b <= width - 78`. A bell 70px from the edge of a 320px screen cannot host a
   * 304px panel with its own right edge, so the panel is pinned to the edge and
   * spans the screen instead — `contained: false` means "the anchor could not be
   * honoured", not "the panel is off screen". From 430px the arithmetic clears and
   * the panel sits under the bell exactly as it always did on desktop.
   */
  it('pins to the edge below 430px, and right-aligns from 430px up', () => {
    for (const { viewport } of VIEWPORTS) {
      const { placed, boxWidth } = measureAsTheBellDoes(viewport)
      const canRightAlign = boxWidth <= viewport.width - 70 - PANEL_EDGE
      expect(placed.contained).toBe(canRightAlign)
      if (canRightAlign) {
        expect(placed.left + boxWidth).toBe(viewport.width - 70)
      } else {
        expect(placed.left).toBe(PANEL_EDGE)
      }
      // On screen either way — that part is not conditional.
      expect(placed.left + boxWidth).toBeLessThanOrEqual(viewport.width)
    }
  })

  it('goes near-full-width on a phone instead of clipping', () => {
    const { boxWidth, placed } = measureAsTheBellDoes({ width: 320, height: 844 })
    // 92vw of a 320px screen is 294; the new bound is 304 and it still fits,
    // because the panel is no longer hung off the bell's right edge.
    expect(boxWidth).toBe(304)
    expect(placed.left).toBe(PANEL_EDGE)
    expect(placed.left + boxWidth).toBe(312)
  })

  it('keeps the desktop anchor: right edge under the bell', () => {
    const viewport = { width: 1440, height: 900 }
    const { placed, boxWidth } = measureAsTheBellDoes(viewport)
    expect(boxWidth).toBe(PANEL_WIDTH)
    expect(placed.left + boxWidth).toBe(1440 - 70)
    expect(placed.top).toBe(8 + 44 + PANEL_GAP)
    expect(placed.placement).toBe('bottom')
  })

  it('is never taller than the room under the header, so vh is not needed', () => {
    for (const { viewport } of VIEWPORTS) {
      const { placed, maxHeight } = measureAsTheBellDoes(viewport)
      expect(maxHeight).toBeGreaterThan(0)
      expect(maxHeight).toBeLessThan(viewport.height)
      expect(placed.placement).toBe('bottom')
      // A short landscape phone is the worst case and still has real room.
      expect(maxHeight).toBeLessThanOrEqual(viewport.height - (8 + 44 + PANEL_GAP) - PANEL_EDGE)
    }
  })
})
