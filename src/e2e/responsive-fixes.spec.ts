import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page, type TestInfo } from '@playwright/test'

/**
 * Responsive regression suite for the five bugs reported from the live Render
 * deployment (desktop + a 360–420px phone), October 2026.
 *
 * Every test below corresponds to one reported symptom, and each one FAILS
 * against the build that shipped the bug — that is the point of the file. They
 * run on all three projects (desktop, Pixel 5, iPad Pro) because the same
 * component is measured under a different pointer model on each: the tooltip has
 * to open on a tap where there is no hover, and a pointer can reach a control a
 * thumb cannot.
 *
 * Widths are set per test rather than inherited from the project, so "360" means
 * 360 on every project and a failure names the width it happened at.
 *
 * Screenshots are written under `test-results/` — gitignored, and removed by the
 * next run. They are evidence for the run that produced them, not baselines: a
 * layout suite that asserts pixel equality with its own last screenshot can
 * never fail, so nothing here compares against them.
 */

const SHOT_DIR = path.join(__dirname, '..', '..', 'test-results', 'responsive-fixes')

/** Viewport screenshot + report attachment, named `<project>-<what>.png`. */
async function shot(page: Page, testInfo: TestInfo, what: string): Promise<void> {
  await fs.promises.mkdir(SHOT_DIR, { recursive: true })
  const file = path.join(SHOT_DIR, `${testInfo.project.name.replace(/\s+/g, '-')}-${what}.png`)
  await page.screenshot({ path: file })
  await testInfo.attach(`${what}.png`, { path: file, contentType: 'image/png' })
}

/** Navigate at an exact CSS pixel width, after the app shell has rendered. */
async function openAt(page: Page, width: number, route: string): Promise<void> {
  await page.setViewportSize({ width, height: 800 })
  await page.goto(route)
  await expect(page.locator('header')).toBeVisible()
}

/**
 * The `box` helper's selector, narrowed to a rendered element. The dashboard
 * renders the Live chip twice on purpose — one for the phone eyebrow, one for the
 * desktop actions row — and only one of them is display-visible at a given width,
 * so a bare `span[title^="Realtime sync"]` resolves to a hidden node.
 */
const visible = (selector: string) => `${selector}:visible`

const box = async (page: Page, selector: string) => {
  const locator = page.locator(visible(selector)).first()
  await expect(locator).toBeVisible()
  const handle = await locator.elementHandle()
  return handle!.evaluate((el: Element) => {
    const r = el.getBoundingClientRect()
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    }
  })
}

/** The document must never scroll sideways: no gutter, no hidden column. */
async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement
    return doc.scrollWidth - doc.clientWidth
  })
  expect(overflow, 'document scrollWidth exceeds clientWidth').toBeLessThanOrEqual(0)
}

/**
 * Task 4's rule as an assertion: an ellipsis is only allowed where the full
 * string is still reachable, i.e. on a name or an id that carries a `title` or
 * `aria-label`. A clipped sentence with no label is the bug that hid
 * "provisional — no movement data yet" behind "provisional — no mo…".
 */
async function expectEveryEllipsisLabelled(page: Page) {
  const offenders = await page.evaluate(() => {
    const bad: string[] = []
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const s = getComputedStyle(el)
      if (!/hidden|clip/.test(s.overflowX)) continue
      if (s.textOverflow !== 'ellipsis') continue
      // Only a box that is losing text right now is a problem.
      if (el.scrollWidth <= el.clientWidth + 1) continue
      const labelled =
        (el as HTMLElement).title ||
        el.getAttribute('aria-label') ||
        el.closest('[title], [aria-label]') ||
        /(^|\s)sr-only(\s|$)/.test(el.className)
      if (labelled) continue
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 48)
      bad.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} "${text}"`)
    }
    return bad
  })
  expect(offenders, `unlabelled truncated text: ${offenders.join(' | ')}`).toEqual([])
}

test.describe('info tooltip on a phone', () => {
  test('stays inside the viewport, wraps, and is 44px to hit', async ({ page }, testInfo) => {
    await openAt(page, 360, '/')

    const help = page.locator('button[aria-label^="What is this?"]').first()
    await expect(help).toBeVisible()
    const target = await box(page, 'button[aria-label^="What is this?"]')
    expect(target.width, '"i" touch target width').toBeGreaterThanOrEqual(44)
    expect(target.height, '"i" touch target height').toBeGreaterThanOrEqual(44)

    // A phone has no hover, so the affordance has to answer to a tap.
    await help.click()
    const tooltip = page.locator('[role="tooltip"]')
    await expect(tooltip).toBeVisible()

    const tip = await box(page, '[role="tooltip"]')
    const vw = 360
    expect(tip.left, 'tooltip clips the left edge').toBeGreaterThanOrEqual(0)
    expect(tip.right, 'tooltip runs past the right edge').toBeLessThanOrEqual(vw)
    expect(tip.top).toBeGreaterThanOrEqual(0)
    expect(tip.bottom, 'tooltip runs below the fold').toBeLessThanOrEqual(800)
    // The brief's ceiling: min(20rem, 100vw - 2rem). At 360px that is 320px.
    expect(tip.width).toBeLessThanOrEqual(Math.min(320, vw - 32) + 1)
    // A single-line black bar across the window was the desktop symptom; wrapping
    // is what makes containment possible, so assert the text is more than a line.
    const wrapped = await tooltip.evaluate((el) => {
      const s = getComputedStyle(el)
      const lineHeight = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.5
      return { lines: Math.round(el.clientHeight / lineHeight), whiteSpace: s.whiteSpace }
    })
    expect(wrapped.whiteSpace).toBe('normal')
    expect(wrapped.lines, 'tooltip text did not wrap').toBeGreaterThan(2)

    await shot(page, testInfo, 'tooltip-360-open')

    // Open means described-by: the link exists only while it is on screen.
    const described = await help.getAttribute('aria-describedby')
    expect(described, 'focused control is not linked to its tooltip').toBeTruthy()
    await expect(page.locator(`[id="${described}"]`)).toHaveCount(1)

    await page.keyboard.press('Escape')
    await expect(tooltip).toHaveCount(0)
    await expect(help).not.toHaveAttribute('aria-describedby', /.*/, { timeout: 2_000 })
  })

  test('does not cover the sidebar or overflow at desktop widths', async ({ page }, testInfo) => {
    await openAt(page, 1280, '/')
    const help = page.locator('button[aria-label^="What is this?"]').first()
    await help.hover()
    const tooltip = page.locator('[role="tooltip"]')
    await expect(tooltip).toBeVisible()
    const tip = await box(page, '[role="tooltip"]')
    expect(tip.width, 'a 1280px-wide tooltip is the reported bug').toBeLessThanOrEqual(321)
    expect(tip.right).toBeLessThanOrEqual(1280)
    await shot(page, testInfo, 'tooltip-1280-open')
    await page.keyboard.press('Escape')
  })
})

test.describe('notification panel', () => {
  test('fits inside the viewport on a 360px phone', async ({ page }, testInfo) => {
    await openAt(page, 360, '/')
    await page.locator('button[aria-label^="Notifications"]').click()
    const panel = page.locator('[role="dialog"][aria-label="Notifications"]')
    await expect(panel).toBeVisible()

    const boxEl = await box(page, '[role="dialog"][aria-label="Notifications"]')
    // The reported symptom was the panel hanging off the LEFT edge, so both sides
    // are asserted, with a margin rather than a bare zero.
    expect(boxEl.left).toBeGreaterThanOrEqual(4)
    expect(boxEl.right).toBeLessThanOrEqual(360 - 4)
    expect(boxEl.top).toBeGreaterThanOrEqual(0)
    expect(boxEl.bottom).toBeLessThanOrEqual(800)
    await expectNoHorizontalScroll(page)

    // A panel that cannot scroll its own list is a clipped panel.
    const scrolls = await panel.evaluate((el) => {
      const list = el.querySelector('.overflow-y-auto')
      return !!list && getComputedStyle(list).overflowY === 'auto'
    })
    expect(scrolls, 'notification list has no internal scroller').toBe(true)

    // The message text is the content that was being cut ("…owner has not
    // enabled…"), so it must be readable, not clamped.
    const clamped = await panel.evaluate(
      () =>
        Array.from(document.querySelectorAll('[role="dialog"] *')).filter((el) => {
          const s = getComputedStyle(el)
          return s.webkitLineClamp !== 'none' && el.scrollWidth > el.clientWidth + 1
        }).length
    )
    expect(clamped, 'a notification message is still line-clamped').toBe(0)

    await shot(page, testInfo, 'notifications-360-open')
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
  })

  test('stays anchored to the bell and inside the viewport on desktop', async ({
    page,
  }, testInfo) => {
    await openAt(page, 1280, '/')
    const bell = await box(page, 'button[aria-label^="Notifications"]')
    await page.locator('button[aria-label^="Notifications"]').click()
    await expect(page.locator('[role="dialog"][aria-label="Notifications"]')).toBeVisible()
    const panel = await box(page, '[role="dialog"][aria-label="Notifications"]')
    expect(panel.top).toBeGreaterThanOrEqual(bell.bottom - 1)
    expect(panel.right).toBeLessThanOrEqual(1280)
    expect(panel.left).toBeGreaterThanOrEqual(0)
    await shot(page, testInfo, 'notifications-1280-open')
  })
})

test.describe('dashboard header on a phone', () => {
  test('stacks Live, then the period control, then Refresh — without wrapping', async ({
    page,
  }, testInfo) => {
    await openAt(page, 360, '/')

    const chip = await box(page, 'span[title^="Realtime sync"]')
    const group = await box(page, '[role="group"][aria-label="Reporting period"]')
    const refresh = await box(page, 'button[aria-label="Refresh dashboard"]')

    // The reported layout was Live to the LEFT of the chips with Custom and
    // Refresh spilling onto further rows. Reading order must be top-down.
    expect(chip.top, 'Live badge is not above the period control').toBeLessThan(group.top)
    expect(group.bottom, 'Refresh is not below the period control').toBeLessThanOrEqual(
      refresh.top + 1
    )
    // One column: nothing sits beside anything else.
    expect(chip.right).toBeLessThanOrEqual(360)
    for (const [name, b] of [
      ['chip', chip],
      ['group', group],
      ['refresh', refresh],
    ] as const) {
      expect(b.left, `${name} runs off the left edge`).toBeGreaterThanOrEqual(0)
      expect(b.right, `${name} runs off the right edge`).toBeLessThanOrEqual(360)
    }
    // The four chips are a 2x2 grid below sm, so the group is two rows tall and
    // every chip is a full 44px target.
    const chips = await page
      .locator('[role="group"][aria-label="Reporting period"] button')
      .evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect()
          return {
            top: Math.round(r.top),
            height: Math.round(r.height),
            width: Math.round(r.width),
          }
        })
      )
    expect(chips).toHaveLength(4)
    for (const c of chips) {
      expect(c.height, 'period chip under 44px').toBeGreaterThanOrEqual(44)
      expect(c.width, 'period chip under 44px').toBeGreaterThanOrEqual(44)
    }
    const rows = new Set(chips.map((c) => c.top))
    expect(rows.size, 'period chips did not form a two-row grid').toBe(2)
    expect(refresh.height).toBeGreaterThanOrEqual(44)

    await expectNoHorizontalScroll(page)
    await shot(page, testInfo, 'dashboard-header-360')
  })

  test('keeps the desktop row intact', async ({ page }, testInfo) => {
    await openAt(page, 1280, '/')
    const chip = await box(page, 'span[title^="Realtime sync"]')
    const group = await box(page, '[role="group"][aria-label="Reporting period"]')
    // Desktop: one row, Live to the left of the selector, as it always was.
    expect(Math.abs(chip.top - group.top)).toBeLessThan(group.height)
    expect(chip.right).toBeLessThan(group.left)
    const rows = await page
      .locator('[role="group"][aria-label="Reporting period"] button')
      .evaluateAll(
        (els) => new Set(els.map((el) => Math.round(el.getBoundingClientRect().top))).size
      )
    expect(rows, 'desktop period control wrapped to a second row').toBe(1)
    await expectNoHorizontalScroll(page)
    await shot(page, testInfo, 'dashboard-header-1280')
  })

  test('report pages sharing the header pattern hold their actions inside the screen', async ({
    page,
  }, testInfo) => {
    const routes = [
      '/finance',
      '/cash-flow',
      '/profit-loss',
      '/budgets',
      '/reconciliation',
      '/weekly-summary',
      '/sync',
    ]
    for (const route of routes) {
      await openAt(page, 360, route)
      await expectNoHorizontalScroll(page)
      const outside = await page.evaluate(() => {
        const vw = window.innerWidth
        return Array.from(document.querySelectorAll('header *, [class*="grid"] > button')).filter(
          (el) => {
            const r = el.getBoundingClientRect()
            if (r.width < 1 || r.height < 1) return false
            const s = getComputedStyle(el)
            if (s.display === 'none' || s.visibility === 'hidden') return false
            return r.right > vw + 1 || r.left < -1
          }
        ).length
      })
      expect(outside, `${route} has controls outside the viewport at 360`).toBe(0)
    }
    await shot(page, testInfo, 'report-header-360-last-page')
  })
})

test.describe('truncated text', () => {
  test('no ellipsis on a phone hides a sentence without a label', async ({ page }, testInfo) => {
    for (const route of ['/', '/finance', '/profit-loss', '/tasks', '/sales']) {
      await openAt(page, 360, route)
      await expectEveryEllipsisLabelled(page)
    }
    await shot(page, testInfo, 'truncation-360')
  })

  test('the advertising source list prints in full on a phone', async ({ page }, testInfo) => {
    await openAt(page, 360, '/')
    // The Expenses widget is the only place the contributing category ids are
    // ever shown, which is why "meta_ads, flyers_…" was the reported cut.
    const advertising = page
      .locator('[data-widget="expenses"] div')
      .filter({ hasText: /^Advertising/ })
      .first()
    await expect(advertising).toBeVisible()

    const read = await advertising.evaluate((row) => {
      const hint = row.querySelector('[title]') as HTMLElement | null
      if (!hint) return { found: false, text: '', title: '', clipped: 0 }
      return {
        found: true,
        text: (hint.textContent || '').trim(),
        title: hint.title,
        clipped: hint.scrollWidth - hint.clientWidth,
      }
    })
    expect(read.found, 'the advertising row has no source hint').toBe(true)
    expect(read.clipped, `source list is clipped by ${read.clipped}px`).toBeLessThanOrEqual(1)
    // The whole string is on screen, so the hover title is a convenience again
    // rather than the only place the sentence exists.
    expect(read.text.length).toBeGreaterThan(0)
    expect(read.text.replace(/\s+/g, ' ')).toBe(read.title.replace(/\s+/g, ' '))
    await shot(page, testInfo, 'advertising-row-360')
  })
})

test.describe('cold start on Render', () => {
  test('a failing first read says "waking up", never "Offline"', async ({ page }, testInfo) => {
    // Only the dashboard read is killed. The session, the notification poll and
    // the live stream stay up, which is exactly the state of a phone with full
    // signal talking to a server that is still booting.
    await page.route('**/api/dashboard*', (route) => route.abort('failed'))
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')

    const waking = page.getByText('Server is waking up, retrying…')
    await expect(waking).toBeVisible()
    await expect(page.getByText(/Attempt \d+, next try in \d+s/)).toBeVisible()

    // The word "Offline" belongs to the browser's own connection, and the browser
    // is online here: `navigator.onLine` is true and no `offline` event fired.
    expect(await page.evaluate(() => navigator.onLine)).toBe(true)
    await expect(page.getByText('Offline', { exact: true })).toHaveCount(0)
    const chip = page.locator('span[title^="Realtime sync"]').first()
    await expect(chip).not.toHaveText('Offline')
    // And the old symptom must not be on screen while the retry loop is still running.
    await expect(page.getByText('Couldn’t load the dashboard')).toHaveCount(0)

    await shot(page, testInfo, 'cold-start-waking')

    // Recovery: the retry loop is on a backoff, so once the server answers the
    // board fills in without a reload.
    await page.unroute('**/api/dashboard*')
    await expect(page.getByText('Sales & Profit')).toBeVisible({ timeout: 30_000 })
    await expect(waking).toHaveCount(0)
    await shot(page, testInfo, 'cold-start-recovered')
  })

  test('a browser that really is offline still says Offline', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    await expect(page.locator('header')).toBeVisible()
    await page.context().setOffline(true)
    // The header pill is the sm+ control; the phone gets the badge. Both read the
    // browser's own state, so `context.setOffline` is the only way to reach them.
    // `:visible` because the hidden sibling variant is in the DOM at this width.
    await expect(page.locator('header span:visible', { hasText: /^Offline$/ }).first()).toBeVisible(
      { timeout: 10_000 }
    )
    await page.context().setOffline(false)
    await shot(page, testInfo, 'truly-offline')
  })
})
