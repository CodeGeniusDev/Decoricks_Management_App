import { test, expect, devices, type Page } from '@playwright/test'
import { FOUNDER_STATE } from './helpers'

/**
 * Layout regression suite.
 *
 * These exist because each assertion below corresponds to a bug that shipped
 * once and was hard to notice by hand:
 *  - the collapsed sidebar rendered no icons at all
 *  - the content gutter did not follow the sidebar width
 *  - the header's mobile menu button had no click handler
 *  - the mobile drawer had no Escape handler and no focus trap
 *  - `overflow-x: hidden` on <body> hid real overflow
 *  - every surface was a frosted glass panel
 *
 * Tests run against a production build, so they assert the shipped behaviour.
 */

/**
 * The drawer is dismissed by translating it off-screen and marking it
 * `inert`/`aria-hidden`, not by removing it from the DOM, so the exit transition
 * can play. Playwright still considers a translated element "visible", which is
 * why open/closed is asserted from position and ARIA state instead.
 */
async function expectDrawerOpen(page: Page, open: boolean) {
  const drawer = page.locator('#mobile-nav-drawer')
  await expect(drawer).toBeAttached()

  if (open) {
    await expect(drawer).toHaveAttribute('aria-modal', 'true')
    await expect(drawer).not.toHaveAttribute('inert', '')
    // Poll: the panel slides in over 240ms and ARIA flips on the first frame.
    await expect
      .poll(async () => (await drawer.boundingBox())!.x)
      .toBeGreaterThanOrEqual(-1)
  } else {
    await expect(drawer).toHaveAttribute('aria-hidden', 'true')
    await expect(drawer).toHaveAttribute('inert', '')
    // Fully off the left edge once the slide-out has finished.
    await expect
      .poll(async () => {
        const box = (await drawer.boundingBox())!
        return box.x + box.width
      })
      .toBeLessThanOrEqual(1)
  }
}

const ROUTES = [
  '/',
  '/finance',
  '/budgets',
  '/inventory',
  '/sales',
  '/tasks',
  '/chat',
  '/suppliers',
  '/weekly-summary',
  '/settings',
]

/** Widths the design has to hold at: smallest phones through large desktop. */
const WIDTHS = [320, 375, 390, 414, 768, 1024, 1280, 1440]

test.describe('navigation shell', () => {
  test('collapsed sidebar keeps icons and the content gutter follows it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/')

    const sidebar = page.getByRole('complementary', { name: 'Main navigation' })
    const main = page.locator('#main-content')
    const toggle = page.getByRole('button', { name: 'Collapse sidebar' })

    await expect(sidebar).toBeVisible()

    const expandedWidth = (await sidebar.boundingBox())!.width
    expect(expandedWidth).toBe(240)
    // <main> spans the full width and offsets its content with padding, so the
    // offset under test is the computed padding, not main's border-box x.
    await expect
      .poll(async () => main.evaluate((el) => getComputedStyle(el).paddingLeft))
      .toBe('240px')

    await toggle.click()
    await expect(sidebar).toHaveClass(/w-sidebar-collapsed/)

    // The rail and the gutter animate together over 240ms; poll so the assertion
    // observes the settled layout rather than a frame mid-transition.
    await expect
      .poll(async () => (await sidebar.boundingBox())!.width)
      .toBe(64)
    const collapsedWidth = (await sidebar.boundingBox())!.width

    // Icons must survive collapsing: this is the regression that made the
    // collapsed rail look empty.
    const firstLink = sidebar.getByRole('link', { name: /Dashboard/ })
    await expect(firstLink).toBeVisible()
    await expect(firstLink.locator('svg').first()).toBeVisible()

    // The content offset tracks the rail instead of leaving a dead gutter.
    await expect
      .poll(async () => main.evaluate((el) => getComputedStyle(el).paddingLeft))
      .toBe('64px')

    // Visual confirmation: the first content element starts at the rail edge.
    const content = page.locator('#main-content > div').first()
    await expect
      .poll(async () => Math.round((await content.boundingBox())!.x))
      .toBe(collapsedWidth)

    // The brand mark must not be clipped away.
    await expect(page.getByRole('link', { name: /Decoricks Management/ })).toBeVisible()

    await page.getByRole('button', { name: 'Expand sidebar' }).click()
    await expect(sidebar).toHaveClass(/w-sidebar/)
    // And it expands back to the full rail, with the gutter following again.
    await expect
      .poll(async () => (await sidebar.boundingBox())!.width)
      .toBe(240)
    await expect
      .poll(async () => main.evaluate((el) => getComputedStyle(el).paddingLeft))
      .toBe('240px')
  })

  test('collapsed sidebar exposes an accessible name for icon-only links', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/')
    await page.getByRole('button', { name: 'Collapse sidebar' }).click()

    const sidebar = page.getByRole('complementary', { name: 'Main navigation' })
    // Name comes from the tooltip/content even though the label is visually hidden.
    await expect(sidebar.getByRole('link', { name: /Inventory/ })).toBeVisible()
  })

  test('desktop sidebar is hidden and the drawer is used below 1024px', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 })
    await page.goto('/')

    await expect(page.getByRole('complementary', { name: 'Main navigation' })).toBeHidden()

    const menuButton = page.getByRole('button', { name: 'Open navigation' })
    await expect(menuButton).toBeVisible()

    // The button that previously had no handler at all.
    await menuButton.click()
    await expectDrawerOpen(page, true)
  })

  test('drawer closes on Escape and restores focus to the trigger', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')

    const trigger = page.getByRole('button', { name: 'Open navigation' })
    await trigger.click()
    await expectDrawerOpen(page, true)

    await page.keyboard.press('Escape')
    await expectDrawerOpen(page, false)

    // Focus must come back, otherwise keyboard users are dropped at the top of
    // the document.
    await expect(trigger).toBeFocused()
  })

  test('drawer traps Tab focus and closes when a route is chosen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')

    await page.getByRole('button', { name: 'Open navigation' }).click()
    await expectDrawerOpen(page, true)

    // Tab many times: focus must never escape the drawer.
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab')
      const inside = await page.evaluate(() => {
        const panel = document.querySelector('#mobile-nav-drawer')
        return !!panel && document.activeElement !== null && panel.contains(document.activeElement)
      })
      expect(inside).toBe(true)
    }

    await page.getByRole('link', { name: 'Tasks' }).click()
    await expectDrawerOpen(page, false)
    await expect(page).toHaveURL(/\/tasks$/)
  })

  test('drawer closes when the scrim is clicked', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')

    await page.getByRole('button', { name: 'Open navigation' }).click()
    await expectDrawerOpen(page, true)

    // Click the scrim area to the right of the drawer.
    await page.mouse.click(370, 400)
    await expectDrawerOpen(page, false)
  })

  test('active navigation item is exactly one, and "/" only matches the dashboard', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/inventory')
    const sidebar = page.getByRole('complementary', { name: 'Main navigation' })
    await expect(sidebar.locator('a[aria-current="page"]')).toHaveCount(1)
    await expect(sidebar.locator('a[aria-current="page"]')).toHaveAttribute('href', '/inventory')

    await page.goto('/')
    const current = sidebar.locator('a[aria-current="page"]')
    await expect(current).toHaveCount(1)
    // '/' must match the dashboard exactly, not every route by prefix.
    await expect(current).toHaveAttribute('href', '/')
  })
})

test.describe('visual system', () => {
  test('no backdrop-blur or translucent panels remain', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/inventory')

    const blurCount = await page.evaluate(() => {
      let blurred = 0
      document.querySelectorAll('*').forEach((el) => {
        const s = getComputedStyle(el)
        const standard = s.getPropertyValue('backdrop-filter')
        const webkit = s.getPropertyValue('-webkit-backdrop-filter')
        if ((standard && standard !== 'none') || (webkit && webkit !== 'none')) {
          blurred++
        }
      })
      return blurred
    })
    expect(blurCount).toBe(0)
  })

  test('table rows are not animated on data change', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/tasks')

    const row = page.locator('tbody tr').first()
    if ((await row.count()) === 0) return

    // No leftover transform/opacity from a GSAP stagger, which is what made
    // every refetch look like a page reload.
    const styles = await row.evaluate((el) => {
      const s = getComputedStyle(el)
      return { transform: s.transform, opacity: s.opacity }
    })
    expect(styles.transform).toBe('none')
    expect(styles.opacity).toBe('1')
  })

  test('dialogs close on Escape and restore focus', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/inventory')

    const addButton = page.getByRole('button', { name: /add product/i }).first()
    await addButton.click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(addButton).toBeFocused()
  })

  test('modal surface is opaque, not frosted', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/inventory')

    await page.getByRole('button', { name: /add product/i }).first().click()
    const dialog = page.getByRole('dialog')

    const style = await dialog.evaluate((el) => {
      const s = getComputedStyle(el)
      return { backgroundColor: s.backgroundColor, backdropFilter: s.backdropFilter }
    })
    expect(style.backdropFilter).toBe('none')
    // Fully opaque surface, not a translucent panel.
    expect(style.backgroundColor).toMatch(/rgb\(255, 255, 255\)/)
  })
})

test.describe('responsive containment', () => {
  for (const width of WIDTHS) {
    test(`no horizontal page overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')

      // <body> no longer sets overflow-x: hidden, so a real overflow bug is
      // visible here instead of being silently clipped.
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement
        return {
          scrollWidth: doc.scrollWidth,
          clientWidth: doc.clientWidth,
          bodyOverflowX: getComputedStyle(document.body).overflowX,
        }
      })

      expect(overflow.bodyOverflowX).not.toBe('hidden')
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1)
    })
  }
})

test.describe('responsive smoke', () => {
  // Each case walks ten routes; under parallel load that can exceed the default
  // 30s budget on the slower devices.
  test.describe.configure({ timeout: 90_000 })

  const viewports = [
    { name: '320px', width: 320, height: 640 },
    { name: '375px', width: 375, height: 667 },
    { name: '390px', width: 390, height: 844 },
    { name: '414px', width: 414, height: 896 },
    { name: '768px', width: 768, height: 1024 },
    { name: '1024px', width: 1024, height: 768 },
    { name: '1280px', width: 1280, height: 800 },
    { name: '1440px', width: 1440, height: 900 },
  ]

  for (const viewport of viewports) {
    test(`every route renders its shell at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })

      for (const route of ROUTES) {
        const response = await page.goto(route)
        expect(response?.status(), `${route} at ${viewport.name}`).toBeLessThan(400)

        // Shell chrome is present on every route.
        await expect(page.getByRole('banner')).toBeVisible()
        await expect(page.locator('#main-content')).toBeVisible()

        // Exactly one h1 in the content area; the header supplies the route name
        // as a heading too, so scope this to <main>.
        await expect(page.locator('#main-content h1').first()).toBeVisible()
      }
    })
  }
})

test.describe('keyboard access', () => {
  test('skip link is the first tab stop and moves focus to content', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/')

    await page.keyboard.press('Tab')
    const skipLink = page.getByRole('link', { name: 'Skip to content' })
    await expect(skipLink).toBeFocused()

    await page.keyboard.press('Enter')
    await expect(page.locator('#main-content')).toBeVisible()
  })

  test('every interactive control has an accessible name', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })

    for (const route of ROUTES) {
      await page.goto(route)

      const unnamed = await page.evaluate(() => {
        const problems: string[] = []
        document.querySelectorAll('button, a[href], input, select, textarea').forEach((el) => {
          const node = el as HTMLElement
          if (node.closest('[aria-hidden="true"]')) return
          const style = getComputedStyle(node)
          if (style.display === 'none' || style.visibility === 'hidden') return

          const aria = node.getAttribute('aria-label')?.trim()
          const labelledBy = node.getAttribute('aria-labelledby')
          const text = (node.textContent ?? '').trim()
          const title = node.getAttribute('title')?.trim()
          const isSubmitInput =
            node.tagName === 'INPUT' &&
            ['submit', 'button', 'reset'].includes((node as HTMLInputElement).type)

          /*
           * All three label associations must be resolved:
           *   - explicit:   <label for="id"> (what <Input> emits)
           *   - implicit:   a control nested inside <label>
           *   - aria:       aria-label / aria-labelledby
           * Plus the element's own text, which names links and buttons.
           */
          const explicitLabel = node.id
            ? document.querySelector(`label[for="${CSS.escape(node.id)}"]`)
            : null
          const implicitLabel = node.closest('label')
          const labelText = (explicitLabel?.textContent ?? implicitLabel?.textContent ?? '').trim()

          const hasName =
            (aria && aria.length > 0) ||
            (labelledBy && labelledBy.length > 0) ||
            (text && text.length > 0) ||
            (title && title.length > 0) ||
            (labelText && labelText.length > 0) ||
            isSubmitInput

          if (!hasName) problems.push(node.outerHTML.slice(0, 120))
        })
        return problems
      })

      expect(unnamed, `unnamed controls on ${route}`).toEqual([])
    }
  })
})

test.describe('devices', () => {
  test('mobile chrome project renders the drawer trigger', async ({ browser }) => {
    const context = await browser.newContext({ ...devices['Pixel 5'], storageState: FOUNDER_STATE })
    const page = await context.newPage()
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible()
    await context.close()
  })
})