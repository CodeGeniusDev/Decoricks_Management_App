import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The two 404 boundaries, checked against the source that ships.
 *
 * A 404 page is the only screen in this app with no test user flow, no API call
 * and no state — and precisely because it is simple, it is the file a refactor
 * breaks quietly: someone points the quick links at a route that was renamed, or
 * copies the sentence into the second boundary so the two 404s stop matching, or
 * adds a `history.back()` button that does nothing on a request the bundle never
 * hydrated. None of those fail a type check.
 *
 * `vitest.config.ts` is `environment: 'node'` with no jsdom, so there is no
 * rendering to assert on. Following the house precedent for structural tests
 * (`overlay-hygiene.test.ts`, `pwa-assets.test.ts`): read the file, assert on it.
 *
 * This deliberately does NOT import `nav-config.tsx`. It has `jsx: 'preserve'`
 * for Next and no React-import-permitting JSX runtime configured for Vitest, so a
 * real import would either fail to transform or fail at load with
 * "React is not defined". Parsing the `href:` literals out of the text checks the
 * same fact with no runtime attached — which matters because a test whose whole
 * job is to keep a page from throwing must not be able to throw itself.
 */

const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')

/** Code only, collapsed to one line so class strings can be matched literally. */
const code = (...parts: string[]) =>
  stripComments(readFileSync(join(process.cwd(), 'src', ...parts), 'utf8')).replace(/\s+/g, ' ')

const PANEL = ['components', 'layout', 'NotFoundPanel.tsx']
const ROOT = ['app', 'not-found.tsx']
const SHELL = ['app', '(app)', 'not-found.tsx']

/*
 * `name:` immediately followed by `href:`, both string literals. Nothing else in
 * either file matches: `nav-config.tsx` puts `icon:` after `href:` (so a trailing
 * `}` would match the panel but silently match ZERO nav items — which is exactly
 * the vacuous-pass trap the first test below exists to catch), and the panel's own
 * `{ name: string; href: string }` type annotation has unquoted values.
 */
const ENTRY = /name:\s*'([^']+)',\s*href:\s*'([^']+)'/g

/** The quick links the panel actually renders. */
const quickLinks = (source: string) =>
  [...source.matchAll(ENTRY)].map(([, name, href]) => ({ name, href }))

/*
 * Route groups are invisible in the URL, so `/finance` is `app/(app)/finance` or
 * `app/(gallery)/finance` on disk. Existence is checked against the filesystem
 * rather than `navItems` because `nav-config.tsx` is a DISPLAY list: renaming a
 * page directory does not touch it, and the sidebar would keep pointing at a 404
 * quietly while a 404 quick link would shout about it.
 */
const routeGroups = readdirSync(join(process.cwd(), 'src', 'app'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)

const hasPage = (href: string) =>
  routeGroups.some((group) =>
    existsSync(join(process.cwd(), 'src', 'app', group, href.replace(/^\//, ''), 'page.tsx'))
  )

describe('NotFoundPanel — the quick links must be real destinations', () => {
  const panel = code(...PANEL)
  const nav = code('components', 'layout', 'nav-config.tsx')
  const links = quickLinks(panel)

  it('parses a non-empty list out of the source', () => {
    // Guards every assertion below: a regex that silently matches nothing makes
    // "every link exists in the nav" true by vacuity.
    expect(links.length).toBeGreaterThanOrEqual(4)
  })

  it('points every link at a route in the nav config', () => {
    const known = new Set(quickLinks(nav).map((item) => item.href))
    expect(known.size).toBeGreaterThanOrEqual(10)
    for (const link of links) expect(known.has(link.href)).toBe(true)
  })

  it.each(links.map((link) => [link.name, link.href] as const))(
    '%s → %s resolves to an actual page.tsx',
    (_name, href) => {
      expect(hasPage(href)).toBe(true)
    }
  )

  it('calls each link what the sidebar calls it', () => {
    // Labels drifting from `navItems` is how a 404 page ends up advertising
    // "Orders" next to a sidebar that says "Sales".
    const byHref = new Map(quickLinks(nav).map((item) => [item.href, item.name]))
    for (const link of links) expect(byHref.get(link.href)).toBe(link.name)
  })

  it('does not list the dashboard it already has a button for', () => {
    expect(links.map((l) => l.href)).not.toContain('/')
    expect(panel).toContain('<Button variant="primary" href="/"')
    expect(hasPage('/')).toBe(true)
  })
})

describe('404 boundaries — one message, two frames', () => {
  const panel = code(...PANEL)
  const root = code(...ROOT)
  const shell = code(...SHELL)

  it('both render the shared panel instead of a private copy', () => {
    for (const boundary of [root, shell]) {
      expect(boundary).toContain(
        "import { NotFoundPanel } from '@/components/layout/NotFoundPanel'"
      )
      expect(boundary).toContain('<NotFoundPanel />')
    }
  })

  it('the sentence exists exactly once in the whole 404 path', () => {
    // The boundaries are the panel's consumers, so a second "Page not found"
    // means someone forked the message and the two 404s now read differently.
    expect((panel.match(/Page not found/g) ?? []).length).toBe(1)
    for (const boundary of [root, shell]) expect(boundary).not.toContain('Page not found<')
  })

  it('only the panel sets a heading', () => {
    // NOT "the page has exactly one h1", because this app does not: measured in a
    // browser, `/`, `/finance` and `/tasks` each carry two — the Header's route
    // title and PageHeader's page title. The panel's single h1 is the second of
    // those two on the shell surface, consistent with every other page. What this
    // guards is the panel not growing a second heading itself, and the boundaries
    // inventing a competing one.
    expect((panel.match(/<h1/g) ?? []).length).toBe(1)
    expect(root).not.toContain('<h1')
    expect(shell).not.toContain('<h1')
  })
})

describe('Root 404 — it has no chrome and must draw its own', () => {
  const root = code(...ROOT)

  it('supplies a page-height frame and the app surface colour', () => {
    // An unmatched route is not inside `(app)/layout.tsx` or `(auth)/layout.tsx`,
    // so without these two classes the panel floats on the browser default: a
    // white void with a card in the top-left corner.
    expect(root).toContain('flex min-h-dvh flex-col bg-surface-app')
  })

  it('uses dvh, not the 100vh that hides content behind a phone URL bar', () => {
    expect(root).not.toContain('min-h-screen')
  })

  it('shows the brand, because an anonymous visitor has no idea where they are', () => {
    expect(root).toContain('<BrandMark')
  })

  it('does not double the gutter the shell boundary already relies on', () => {
    // `(app)` gets `page-max page-pad` from AppShell; it may only add padding-
    // vertical and centring.
    const shell = code(...SHELL)
    expect(shell).toContain('flex justify-center py-6 sm:py-10')
    expect(shell).not.toContain('bg-surface-app')
    expect(shell).not.toContain('page-pad')
  })
})

describe('The 404 path must render with no JavaScript at all', () => {
  const files: [string, string][] = [
    ['panel', code(...PANEL)],
    ['root boundary', code(...ROOT)],
    ['shell boundary', code(...SHELL)],
  ]

  it.each(files)('%s is not a client component', (_name, source) => {
    expect(source).not.toContain("'use client'")
    expect(source).not.toContain('useState')
    expect(source).not.toContain('useEffect')
  })

  it.each(files)('%s has no handler-only exit', (_name, source) => {
    // `onClick={() => history.back()}` looks like a good idea and is inert on
    // exactly the request where the bundle failed. Both exits are anchors.
    expect(source).not.toContain('onClick=')
    expect(source).not.toContain('history.back')
  })

  it('renders the exits as href links', () => {
    const panel = code(...PANEL)
    expect(panel).toContain('<Link')
    expect(panel.match(/href=/g)!.length).toBeGreaterThanOrEqual(2)
  })
})

describe('The panel must not be able to widen the page', () => {
  const panel = code(...PANEL)

  it('is fluid with a ceiling, and its link row wraps', () => {
    // Fixed pixel widths are what pushed the dashboard 39px past a 768px screen.
    expect(panel).toContain('w-full max-w-lg')
    expect(panel).toContain('flex flex-wrap gap-x-1')
    expect(panel).not.toMatch(/min-w-\[\d+px\]/)
  })

  it('gives every quick link a 44px target', () => {
    expect(panel).toContain('min-h-11 items-center')
  })

  it('has no fixed height that could clip its own copy', () => {
    // `max-h-[75vh]` + `overflow` is how the notification panel lost items.
    expect(panel).not.toMatch(/max-h-\[\d+\w+\]/)
    expect(panel).not.toContain('overflow-hidden')
  })
})
