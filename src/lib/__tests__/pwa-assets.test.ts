/**
 * PWA asset validity tests (Phase 9 mobile readiness).
 *
 * These lock the failure modes that made "Add to Home Screen" and push
 * notifications unreliable, all of which are structural and need no browser:
 *
 *   • THE MANIFEST IS THE INSTALL CONTRACT — it must parse, be standalone, and
 *     every icon it declares must exist on disk with the REAL pixel size it
 *     claims. A manifest that lists a 512 icon which is actually 250px (or is
 *     not a PNG at all) installs with a broken or missing icon.
 *   • CONTENT TYPES FOLLOW CONTENT, NOT FILENAMES — the original `favicon.svg`
 *     carried PNG bytes with an .svg name, so any consumer trusting the suffix
 *     (or the server's `image/svg+xml`) got garbage. Asserted by magic bytes.
 *   • NOTIFICATION ICONS ARE RASTER — the service worker's `showNotification`
 *     `icon`/`badge` must point at PNGs; SVG is not reliably rendered, which is
 *     exactly the case on Android and iOS installs.
 *   • THE SHELL CACHE MATCHES THE MANIFEST — every manifest PNG must also be
 *     precached, or the installed app shows a blank icon offline.
 *   • BRAND ONLY — icon artwork uses the five brand colours, no white, no
 *     gradient (design rule for the mark).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PUBLIC_DIR = join(process.cwd(), 'public')
const readAsset = (relPath: string) => join(PUBLIC_DIR, relPath)

/** PNG magic number — the only trustworthy way to know a file is a PNG. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** The five brand colours declared as custom properties in `globals.css`. */
const BRAND_COLORS = ['#0a0908', '#2b2b2b', '#f2f4f3', '#806351', '#634d3d']

type ManifestIcon = { src: string; sizes: string; type: string; purpose?: string }

const readManifest = (): {
  name: string
  start_url: string
  scope: string
  display: string
  theme_color: string
  background_color: string
  icons: ManifestIcon[]
} => {
  const raw = readFileSync(readAsset('manifest.webmanifest'), 'utf8')
  return JSON.parse(raw)
}

/** Real width/height from the IHDR chunk (big-endian at fixed offsets). */
const pngDimensions = (file: string): { width: number; height: number } => {
  const bytes = readFileSync(file)
  expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE), `${file} is not a PNG`).toBe(true)
  // 8-byte signature + 4-byte length + "IHDR", then width(4) height(4).
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe('PWA manifest', () => {
  it('is valid JSON with an installable configuration', () => {
    const manifest = readManifest()
    expect(manifest.name).toBeTruthy()
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
    // standalone is what makes the installed app hide the browser chrome,
    // and the condition for push to be attributable to the app on Android.
    expect(manifest.display).toBe('standalone')
    expect(manifest.theme_color).toBe('#2b2b2b')
    expect(manifest.background_color).toBe('#f2f4f3')
  })

  it('ships raster PNG icons at 192 and 512, for both any and maskable', () => {
    const icons = readManifest().icons
    const pngs = icons.filter((icon) => icon.type === 'image/png')
    for (const purpose of ['any', 'maskable']) {
      for (const size of ['192x192', '512x512']) {
        const found = pngs.some(
          (icon) => icon.sizes === size && (icon.purpose ?? 'any') === purpose
        )
        expect(found, `manifest is missing a PNG icon for ${purpose} ${size}`).toBe(true)
      }
    }
  })

  it('declares PNG files that exist and really are that size', () => {
    for (const icon of readManifest().icons.filter((i) => i.type === 'image/png')) {
      const file = readAsset(icon.src.replace(/^\//, ''))
      const { width, height } = pngDimensions(file)
      expect(`${width}x${height}`, `${icon.src} is not ${icon.sizes}`).toBe(icon.sizes)
    }
  })

  it('keeps the SVG icons vector, not mislabeled raster bytes', () => {
    for (const icon of readManifest().icons.filter((i) => i.type === 'image/svg+xml')) {
      const text = readFileSync(readAsset(icon.src.replace(/^\//, '')), 'utf8')
      expect(text.trimStart().startsWith('<svg'), `${icon.src} is not an SVG`).toBe(true)
    }
  })

  it('provides a separate 180x180 apple-touch-icon for iOS', () => {
    const { width, height } = pngDimensions(readAsset('icons/apple-touch-icon.png'))
    expect(`${width}x${height}`).toBe('180x180')
  })
})

describe('favicon files carry bytes matching their name', () => {
  it('favicon.svg is genuine SVG (regression: it used to hold PNG bytes)', () => {
    const file = readAsset('favicon.svg')
    const bytes = readFileSync(file)
    expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE), 'favicon.svg still holds PNG bytes').toBe(
      false
    )
    expect(bytes.toString('utf8').trimStart().startsWith('<svg')).toBe(true)
  })

  it('favicon.ico is a real ICO container wrapping a PNG image', () => {
    const bytes = readFileSync(readAsset('favicon.ico'))
    // ICO header: reserved(2)=0, type(2)=1, count(2).
    expect(bytes.readUInt16LE(0), 'ICO reserved field').toBe(0)
    expect(bytes.readUInt16LE(2), 'ICO type field').toBe(1)
    expect(bytes.readUInt16LE(4) >= 1, 'ICO holds at least one image').toBe(true)
    // The single embedded payload is a PNG (permitted by the ICO format).
    expect(bytes.subarray(22, 30).equals(PNG_SIGNATURE), 'ICO payload is not a PNG').toBe(true)
  })
})

describe('brand icon artwork', () => {
  it('uses only brand colours in the SVG marks', () => {
    for (const name of ['icon.svg', 'maskable-icon.svg', 'favicon.svg']) {
      const svg = readFileSync(readAsset(name), 'utf8')
      const fills = [...svg.matchAll(/fill="([^"]+)"/g)].map((match) => match[1].toLowerCase())
      expect(fills.length, `${name} declares no fills`).toBeGreaterThan(0)
      for (const fill of fills) {
        expect(BRAND_COLORS, `${name} uses non-brand colour ${fill}`).toContain(fill)
      }
      // A gradient would need a <defs> block; the mark is flat by design.
      expect(svg.includes('<linearGradient'), `${name} has a gradient`).toBe(false)
    }
  })
})

describe('service worker shell', () => {
  const sw = () => readFileSync(readAsset('sw.js'), 'utf8')

  it('shows notifications with raster icons, never SVG', () => {
    const source = sw()
    expect(/icon:\s*'\/icons\/[a-z0-9-]+\.png'/.test(source), 'notification icon must be PNG').toBe(
      true
    )
    expect(
      /badge:\s*'\/icons\/[a-z0-9-]+\.png'/.test(source),
      'notification badge must be PNG'
    ).toBe(true)
    expect(source).not.toMatch(/icon:\s*'[^']+\.svg'/)
    expect(source).not.toMatch(/badge:\s*'[^']+\.svg'/)
  })

  it('precaches every raster icon the manifest declares', () => {
    const source = sw()
    const shell = source.match(/const SHELL_ASSETS = \[([\s\S]*?)\]/)
    expect(shell, 'SHELL_ASSETS not found').toBeTruthy()
    for (const icon of readManifest().icons.filter((i) => i.type === 'image/png')) {
      expect(shell![1].includes(icon.src), `${icon.src} is in the manifest but not precached`).toBe(
        true
      )
    }
  })

  it('registers a shell that exists on disk', () => {
    const source = sw()
    const shell = source.match(/const SHELL_ASSETS = \[([\s\S]*?)\]/)![1]
    const paths = [...shell.matchAll(/'\/([^']+)'/g)].map((match) => match[1])
    expect(paths.length).toBeGreaterThan(0)
    for (const relPath of paths) {
      expect(
        () => readFileSync(readAsset(relPath)),
        `sw.js precaches missing ${relPath}`
      ).not.toThrow()
    }
  })
})
