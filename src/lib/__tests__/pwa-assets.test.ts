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
 *   • CONTENT TYPES FOLLOW CONTENT, NOT FILENAMES — `favicon.svg` and
 *     `icon.svg` used to carry PNG bytes under an .svg name, so any consumer
 *     trusting the suffix (or the server's `image/svg+xml`) got garbage. The
 *     brand artwork is raster, so the icon set is raster now and this file
 *     fails if an .svg icon name comes back without real SVG bytes behind it.
 *   • MASKABLE MEANS EDGE TO EDGE — a maskable tile is put through the
 *     launcher's own circular/squircle mask, so any transparency in it shows
 *     the launcher background through the shape. iOS composites
 *     `apple-touch-icon` onto black the same way. The tiles are therefore
 *     written with no alpha channel at all, which is checked from the chunk
 *     list rather than sampled: a palette PNG can hold a transparent entry no
 *     pixel uses, so "does any byte say 0" proves nothing either way.
 *   • NOTIFICATION ICONS ARE RASTER — the service worker's `showNotification`
 *     `icon`/`badge` must point at PNGs; SVG is not reliably rendered, which is
 *     exactly the case on Android and iOS installs.
 *   • THE SHELL CACHE MATCHES THE MANIFEST — every manifest PNG must also be
 *     precached, or the installed app shows a blank icon offline. The same
 *     applies to the mark the chrome itself renders.
 *   • BRAND ONLY — the badge is the brand brown field with the white monogram;
 *     the palette is checked so a wrong artwork cannot be committed green.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PUBLIC_DIR = join(process.cwd(), 'public')
const readAsset = (relPath: string) => join(PUBLIC_DIR, relPath)
const readBytes = (relPath: string) => readFileSync(readAsset(relPath))

/** PNG magic number — the only trustworthy way to know a file is a PNG. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** The five brand colours declared as custom properties in `globals.css`. */
const BRAND_COLORS = ['#0a0908', '#2b2b2b', '#f2f4f3', '#806351', '#634d3d']

/** `--color-brown`: the fill of the badge, and the colour a wrong icon lacks. */
const BRAND_BROWN_RGB = Buffer.from([0x80, 0x63, 0x51])

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

/**
 * Chunk type -> first chunk payload, walked from the file's own structure.
 *
 * Only the chunk framing is parsed (4-byte length, 4-byte type, payload, 4-byte
 * CRC), which is enough to read IHDR, PLTE and tRNS without a PNG decoder.
 */
const pngChunks = (bytes: Buffer): Map<string, Buffer> => {
  expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE), 'not a PNG').toBe(true)
  const chunks = new Map<string, Buffer>()
  let cursor = 8
  while (cursor + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(cursor)
    const type = bytes.subarray(cursor + 4, cursor + 8).toString('ascii')
    const data = bytes.subarray(cursor + 8, cursor + 8 + length)
    if (!chunks.has(type)) chunks.set(type, Buffer.from(data))
    cursor += 12 + length
    if (type === 'IEND') break
  }
  return chunks
}

/** Real width/height from the IHDR chunk (big-endian at fixed offsets). */
const pngDimensions = (file: string): { width: number; height: number } => {
  const ihdr = pngChunks(readFileSync(file)).get('IHDR')
  expect(ihdr, `${file} has no IHDR`).toBeTruthy()
  return { width: ihdr!.readUInt32BE(0), height: ihdr!.readUInt32BE(4) }
}

/**
 * Whether the file can express transparency at all.
 *
 * A palette PNG puts alpha in the tRNS chunk, one byte per palette entry, so
 * greyness alone says nothing — an entry no pixel uses may legitimately be 0.
 * What is decisive is the absence of both an alpha colour type (6 RGBA, 4
 * grey+alpha) and a tRNS chunk: a file like that cannot be transparent, and the
 * maskable tiles are written as RGB precisely so this holds.
 */
const pngCanBeTransparent = (file: string): boolean => {
  const chunks = pngChunks(readFileSync(file))
  const colorType = chunks.get('IHDR')![9]
  return colorType === 4 || colorType === 6 || chunks.has('tRNS')
}

const pngPaletteContains = (file: string, colour: Buffer): boolean => {
  const plte = pngChunks(readFileSync(file)).get('PLTE')
  expect(plte, `${file} is not a palette PNG`).toBeTruthy()
  const palette = plte!
  for (let i = 0; i + 3 <= palette.length; i += 3) {
    if (palette.subarray(i, i + 3).equals(colour)) return true
  }
  return false
}

const iconFiles = (purpose?: string) =>
  readManifest()
    .icons.filter((icon) => !purpose || (icon.purpose ?? 'any') === purpose)
    .map((icon) => icon.src.replace(/^\//, ''))

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
      expect(existsSync(file), `${icon.src} is declared but missing`).toBe(true)
      const { width, height } = pngDimensions(file)
      expect(`${width}x${height}`, `${icon.src} is not ${icon.sizes}`).toBe(icon.sizes)
    }
  })

  it('declares no SVG icon, because the brand artwork is raster', () => {
    // The set went raster on purpose: the badge exists only as a bitmap, and an
    // .svg name is what turned the old files into a silent install failure.
    // Reintroducing an SVG is fine ONLY with real SVG bytes and this test moved
    // with the decision — it is not a thing to delete to get green.
    for (const icon of readManifest().icons) {
      expect(icon.type, `${icon.src} declares SVG`).not.toBe('image/svg+xml')
      expect(icon.src, `${icon.src} is an SVG icon`).not.toMatch(/\.svg$/)
    }
  })

  it('provides a separate 180x180 apple-touch-icon for iOS', () => {
    const { width, height } = pngDimensions(readAsset('icons/apple-touch-icon.png'))
    expect(`${width}x${height}`).toBe('180x180')
  })

  it('keeps every maskable tile and the apple icon structurally opaque', () => {
    const opaque = [...iconFiles('maskable'), 'icons/apple-touch-icon.png']
    for (const src of opaque) {
      expect(
        pngCanBeTransparent(readAsset(src)),
        `${src} can go transparent: the launcher mask or iOS would paint the ` +
          'background straight through the icon'
      ).toBe(false)
    }
  })

  it('keeps the "any" icons able to carry the badge silhouette', () => {
    // The mirror of the rule above: the non-maskable tiles are the round badge
    // on nothing, so the file must have an alpha channel to cut the corners
    // away. An opaque "any" icon installs as a brown square with a circle drawn
    // on it.
    for (const src of ['icons/icon-192.png', 'icons/icon-512.png']) {
      expect(pngCanBeTransparent(readAsset(src)), `${src} lost its alpha`).toBe(true)
    }
  })
})

describe('favicon.ico', () => {
  const ico = () => readBytes('favicon.ico')

  it('is a real ICO container, not a renamed bitmap', () => {
    const bytes = ico()
    // ICO header: reserved(2)=0, type(2)=1, count(2).
    expect(bytes.readUInt16LE(0), 'ICO reserved field').toBe(0)
    expect(bytes.readUInt16LE(2), 'ICO type field').toBe(1)
    expect(bytes.readUInt16LE(4) >= 1, 'ICO holds at least one image').toBe(true)
  })

  it('holds PNG payloads at 16, 32 and 48, each matching its directory entry', () => {
    const bytes = ico()
    const count = bytes.readUInt16LE(4)
    const sizes: number[] = []
    // Directory entries are 16 bytes from offset 6: w(1) h(1) palette(1)
    // reserved(1) planes(2) bpp(2) bytesInRes(4) offset(4). A 0 byte in the
    // width/height field is the format's encoding of 256.
    for (let i = 0; i < count; i += 1) {
      const entry = 6 + i * 16
      const width = bytes[entry] === 0 ? 256 : bytes[entry]
      const height = bytes[entry + 1] === 0 ? 256 : bytes[entry + 1]
      const payloadSize = bytes.readUInt32LE(entry + 8)
      const payloadAt = bytes.readUInt32LE(entry + 12)
      const payload = bytes.subarray(payloadAt, payloadAt + payloadSize)
      // The offset in the directory is authoritative; hardcoding one assumes a
      // single-image file and breaks the moment a second size is added.
      expect(payload.subarray(0, 8).equals(PNG_SIGNATURE), `entry ${i} is not a PNG`).toBe(true)
      const ihdr = pngChunks(payload).get('IHDR')
      expect(`${ihdr!.readUInt32BE(0)}x${ihdr!.readUInt32BE(4)}`).toBe(`${width}x${height}`)
      sizes.push(width)
    }
    for (const size of [16, 32, 48]) {
      expect(sizes, `favicon.ico has no ${size}px image`).toContain(size)
    }
  })
})

describe('brand icon artwork', () => {
  it('paints the badge in the brand brown', () => {
    for (const src of ['icons/icon-512.png', 'icons/icon-maskable-512.png', 'brand-mark.png']) {
      expect(
        pngPaletteContains(readAsset(src), BRAND_BROWN_RGB),
        `${src} does not contain ${BRAND_BROWN_RGB.toString('hex')} — wrong artwork`
      ).toBe(true)
    }
  })

  it('ships no mislabeled SVG icon anywhere in public', () => {
    // The general form of the rule the old files broke: whatever the extension
    // promises, the bytes must deliver. There are no .svg icons now, so any one
    // that appears must genuinely be a vector.
    const svgIcons = ['favicon.svg', 'icon.svg', 'maskable-icon.svg']
    for (const name of svgIcons) {
      const file = readAsset(name)
      if (!existsSync(file)) continue
      const bytes = readFileSync(file)
      expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE), `${name} holds PNG bytes`).toBe(false)
      expect(bytes.toString('utf8').trimStart().startsWith('<svg'), `${name} is not SVG`).toBe(true)
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

  it('precaches the tab icon and the mark the chrome renders', () => {
    // Both are requested on first paint of the shell. Not precaching them means
    // an installed app opened offline shows a blank square where the brand is.
    const shell = sw().match(/const SHELL_ASSETS = \[([\s\S]*?)\]/)![1]
    expect(shell).toContain("'/favicon.ico'")
    expect(shell).toContain("'/brand-mark.png'")
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

describe('icon metadata', () => {
  const layout = () => readFileSync(join(process.cwd(), 'src', 'app', 'layout.tsx'), 'utf8')

  it('points every declared icon at a file that exists and matches its name', () => {
    const urls = [...layout().matchAll(/url: '\/([^']+)'/g)].map((match) => match[1])
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) {
      expect(existsSync(readAsset(url)), `/layout.tsx declares missing /${url}`).toBe(true)
      if (url.endsWith('.png')) {
        expect(readBytes(url).subarray(0, 8).equals(PNG_SIGNATURE), `/${url} is not a PNG`).toBe(
          true
        )
      }
      if (url.endsWith('.ico')) {
        expect(readBytes(url).readUInt16LE(2), `/${url} is not an ICO`).toBe(1)
      }
    }
  })

  it('renders the brand mark in the chrome from the same artwork', () => {
    const brandMark = readFileSync(
      join(process.cwd(), 'src', 'components', 'layout', 'BrandMark.tsx'),
      'utf8'
    )
    expect(brandMark).toContain('src="/brand-mark.png"')
    // Decorative: every caller already labels it with the product name, so a
    // non-empty alt would announce "Decoricks" twice per screen reader pass.
    expect(brandMark).toContain('alt=""')
    expect(readBytes('brand-mark.png').subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
  })

  it('keeps the manifest colours inside the brand palette', () => {
    const { theme_color: theme, background_color: background } = readManifest()
    expect(BRAND_COLORS).toContain(theme)
    expect(BRAND_COLORS).toContain(background)
  })
})
