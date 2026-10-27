import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Overlay and layout hygiene, read from source.
 *
 * This repo has no DOM test environment (`vitest.config.ts` is
 * `environment: 'node'`, no jsdom, no React rendering), so a class-string
 * regression cannot be caught behaviourally by a unit test — and the three bugs
 * this file guards were ALL class strings: `whitespace-nowrap` on a tooltip that
 * holds a 200-character financial definition, `max-h-[75vh]` and `absolute
 * right-0` on a notification panel anchored to a bell 70px from the screen edge,
 * and a `sm:flex-row` header with no wrap whose `shrink-0` action block asked a
 * 768px page for 819px. The arithmetic of placement itself is covered by
 * `ui-placement.test.ts`; this file pins the CSS that makes that arithmetic
 * reachable, because the next refactor can delete it without breaking a single
 * type or a single numeric assertion.
 *
 * Following the house precedent for structural tests (`pwa-assets.test.ts`,
 * `auth-route-coverage.test.ts`): read the shipped source and assert on it.
 */

/*
 * Comments are stripped FIRST, and that is not a detail. Every fix in this file is
 * described in a comment that names the class it forbids — Tooltip.tsx explains
 * that the box "carried `whitespace-nowrap`", NotificationBell.tsx explains that it
 * used to be `absolute right-0` with `max-h-[75vh]`. Asserting against the raw file
 * makes those explanations fail the test they document, which is the same trap the
 * first draft of this file fell into. Code, not prose.
 */
const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')

const src = (...parts: string[]) =>
  stripComments(readFileSync(join(process.cwd(), 'src', ...parts), 'utf8')).replace(/\s+/g, ' ')

describe('Tooltip — the definition box must fit the screen it is on', () => {
  const tooltip = src('components', 'ui', 'Tooltip.tsx')

  it('never refuses to wrap', () => {
    // The exact class that made a dashboard tooltip 1386px wide at every viewport.
    expect(tooltip).not.toContain('whitespace-nowrap')
    expect(tooltip).toContain('whitespace-normal')
    expect(tooltip).toContain('break-words')
  })

  it('is bounded by the viewport, not by its own text', () => {
    // The ceiling is a JS constant rather than a Tailwind arbitrary value, because
    // it is applied as an inline style in BOTH states — before placement has run
    // and after — so a first measurement can never see an unbounded box. It must
    // reference the viewport: a long definition has to WRAP, not extend.
    expect(tooltip).toMatch(/MAX_WIDTH\s*=\s*'min\(20rem, ?calc\(100vw ?- ?2rem\)\)'/)
    expect(tooltip).toContain('maxWidth: MAX_WIDTH')
    expect(tooltip).toMatch(/max-h-\[/)
    expect(tooltip).toContain('overflow-y-auto')
    expect(tooltip).toContain('overscroll-contain')
  })

  it('is placed by the shared rule, so it cannot be pushed to a random edge', () => {
    expect(tooltip).toContain('placeFloating')
  })

  it('opens on focus and tap, and closes on Escape and outside press', () => {
    // Not hover-exclusive: a touch screen has no hover, and a keyboard user has
    // no pointer.
    expect(tooltip).toContain('onFocusCapture')
    expect(tooltip).toContain('onBlurCapture')
    expect(tooltip).toContain('onPointerDown')
    expect(tooltip).toContain("addEventListener('pointerdown'")
    expect(tooltip).toContain("event.key === 'Escape'")
  })

  it('only takes pointer events when its own text needs scrolling', () => {
    // A tooltip that swallows pointer events is a tooltip you cannot scroll.
    expect(tooltip).toMatch(/scrollable \? 'pointer-events-auto' : 'pointer-events-none'/)
  })
})

describe('NotificationBell — the panel belongs to the viewport, not to the bell', () => {
  const bell = src('components', 'notifications', 'NotificationBell.tsx')

  it('has no vh-based height and no bell-anchored absolute positioning', () => {
    expect(bell).not.toContain('max-h-[75vh]')
    expect(bell).not.toContain('absolute right-0')
    expect(bell).toContain('fixed')
  })

  it('derives its box from the shared placement rule', () => {
    expect(bell).toContain('placeFloating')
    expect(bell).toContain('roomBelow')
    expect(bell).toContain('maxBox')
    // The list scrolls inside the panel; the panel does not overflow the phone.
    expect(bell).toContain('min-h-0 flex-1 overflow-y-auto')
  })

  it('can be closed three different ways', () => {
    expect(bell).toContain('Close notifications')
    expect(bell).toContain("event.key === 'Escape'")
    // `pointerdown`, not `mousedown`: the compatibility event is late on a phone.
    expect(bell).toContain("addEventListener('pointerdown'")
    expect(bell).not.toContain("addEventListener('mousedown'")
  })

  it('re-anchors when the viewport changes', () => {
    // Rotation, split-screen resize, and the mobile URL bar settling.
    expect(bell).toContain("addEventListener('resize'")
    expect(bell).toContain("addEventListener('orientationchange'")
  })

  it('keeps the header row from being squeezed off by a long list', () => {
    expect(bell).toContain('flex shrink-0 items-center')
  })
})

describe('PageHeader — the actions block may not widen the document', () => {
  const page = src('components', 'layout', 'Page.tsx')

  it('wraps at sm instead of pushing the page sideways', () => {
    // `shrink-0` with no wrap is what asked a 768px page for 819px of width.
    expect(page).toContain('sm:flex-row sm:flex-wrap')
  })

  it('gives the wrapped actions block a ceiling, or the wrap cannot happen', () => {
    // The second half of the same bug, and the half a `flex-wrap` alone does not
    // fix: a `shrink-0` flex item is sized to its MAX-CONTENT width, so after the
    // wrap the dashboard's actions block still measured 790px inside a 720px tablet
    // content box. `max-w-full` is what bounds the line and makes wrapping
    // reachable; deleting it re-opens the overflow without touching `flex-wrap`.
    expect(page).toContain('max-w-full shrink-0 flex-wrap')
  })

  it('renders an eyebrow above the title', () => {
    // The dashboard needs the Live chip above the heading on a phone and beside
    // the controls on desktop; there is no way to do that from one place in the
    // DOM, so PageHeader owns the second slot.
    expect(page).toContain('eyebrow')
    expect(page.indexOf('{eyebrow}')).toBeLessThan(page.indexOf('<h1'))
  })
})

describe('Dashboard header cluster at mobile', () => {
  const view = src('components', 'dashboard', 'DashboardView.tsx')
  const selector = src('components', 'dashboard', 'PeriodSelector.tsx')

  it('shows exactly one Live chip per breakpoint, above the title on phones', () => {
    expect(view).toContain('sm:hidden')
    expect(view).toContain('hidden sm:inline-flex')
    expect(view).toContain('eyebrow=')
  })

  it('stacks the cluster on phones and keeps the desktop row', () => {
    expect(view).toContain('flex w-full flex-col items-stretch gap-2 sm:w-auto')
    expect(view).toContain('sm:flex-row sm:flex-wrap sm:items-center')
    // Bounded like the block above it, or it inherits the same max-content overflow.
    expect(view).toContain('sm:max-w-full')
  })

  it('gives the four period options a 2x2 grid, not four squeezed pills', () => {
    expect(selector).toContain('grid grid-cols-2')
    expect(selector).toContain('sm:inline-flex')
  })

  it('puts the custom date inputs on one bounded row', () => {
    expect(selector).toContain('grid-cols-[1fr_auto_1fr]')
    // `w-full min-w-0` is what lets a date input shrink instead of setting a
    // minimum width for the page.
    expect(selector).toContain('w-full min-w-0')
  })

  it('gives Refresh the full row on a phone', () => {
    expect(selector).toContain('w-full justify-center sm:w-auto')
  })

  it('lets its own row shrink, so flex-wrap has a width to wrap inside', () => {
    // `min-w-0` on the flex item and `sm:max-w-full` are what turn the four
    // controls from one 790px max-content line into a wrapping row. Without them
    // the row is unconstrained at every breakpoint above `sm`.
    expect(selector).toContain('flex min-w-0 flex-col gap-2 sm:max-w-full sm:flex-row sm:flex-wrap')
  })
})

describe('Dashboard widgets', () => {
  const widgets = src('components', 'dashboard', 'widgets.tsx')

  it('stacks the two PKR cash tiles on a phone', () => {
    // The only two-up tiles on the board that hold a money figure.
    expect(widgets).toContain('grid grid-cols-1 gap-2 sm:grid-cols-2')
    // Small integer counts stay two-up — they were never the problem.
    expect(widgets).toContain('mb-2 grid grid-cols-2 gap-2')
  })

  it('keeps the board a single column below md', () => {
    expect(widgets).toContain('grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3')
  })
})
