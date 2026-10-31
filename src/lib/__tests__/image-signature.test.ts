/**
 * Profile-picture content validation (`src/lib/image-signature.ts`).
 *
 * The upload route stores whatever this returns, so this is the layer that decides
 * whether a byte string is allowed to be served back to every tab of this origin
 * later. Two properties matter and are asserted for each format:
 *
 *   • REAL ENCODER OUTPUT IS ACCEPTED. The assertions that carry the most weight
 *     read `public/brand-mark.png` — bytes a genuine PNG encoder produced — rather
 *     than only synthetic fixtures, because a checker written against its own idea
 *     of a format passes on exactly the shapes it invented. The synthetic buffers
 *     exist for the boundary cases a real file cannot be talked into producing on
 *     demand: a truncated tail, a wrong fourcc, a second document appended after
 *     the image, a size on the exact limit.
 *   • EVERYTHING ELSE IS REFUSED WITH A REASON. A rejection has to say why, since
 *     the message is what the user sees after choosing a file.
 *
 * What this module is NOT: a decoder. A PNG-shaped buffer with a 13-byte IHDR, an
 * `IEND` at the end and garbage in between is accepted, because reading a chunk
 * table and validating pixel data would mean adding `sharp` — a native binary on a
 * free-tier host — for a file that is displayed at 128px by its owner and nobody
 * else. The value of the check is that the STORED CONTENT TYPE is the one sniffed
 * here, never the one the uploader claimed, and that the bytes cannot be an HTML
 * or SVG document wearing an image extension: an accurate `Content-Type` plus the
 * `nosniff` header is what makes a file that got through the border checks inert.
 * These tests pin that contract rather than pretending the image was decoded.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  MAX_IMAGE_BYTES,
  MAX_MULTIPART_BODY_BYTES,
  declaredTypeMatches,
  inspectImage,
  type ImageContentType,
} from '@/lib/image-signature'

/* -------------------------------- fixtures --------------------------------- */

type Bytes = number[] | Uint8Array

const ascii = (text: string): number[] => Array.from(text, (char) => char.charCodeAt(0))

/** Byte concatenation without `Array.prototype.flat`, which a 2 MB pad cannot afford. */
const concat = (...parts: Bytes[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part instanceof Uint8Array ? part : Uint8Array.from(part), at)
    at += part.length
  }
  return out
}

const filler = (length: number, byte = 0x41): Uint8Array => new Uint8Array(length).fill(byte)

/** A real PNG, produced by an encoder rather than by this file. */
const realPng = (): Uint8Array =>
  new Uint8Array(readFileSync(path.join(process.cwd(), 'public', 'brand-mark.png')))

const be32 = (n: number): number[] => [
  (n >>> 24) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
]
const le32 = (n: number): number[] => [
  n & 0xff,
  (n >>> 8) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 24) & 0xff,
]

/**
 * The smallest buffer that is a PNG as far as structure goes: signature, an IHDR
 * chunk header declaring its 13 bytes, and the closing IEND chunk with its fixed
 * CRC. `pad` fills the middle so the total size can be dialled to a boundary —
 * 45 bytes of framing plus the pad.
 */
const png = (pad = 32): Uint8Array =>
  concat(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    be32(13),
    ascii('IHDR'),
    filler(13, 0),
    filler(4, 0), // IHDR CRC placeholder
    filler(pad),
    be32(0),
    ascii('IEND'),
    [0xae, 0x42, 0x60, 0x82]
  )

/** SOI, an APP0/JFIF header, scan data, EOI. */
const jpeg = (pad = 32): Uint8Array =>
  concat(
    [0xff, 0xd8, 0xff, 0xe0],
    ascii('JFIF'),
    [0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
    filler(pad, 0x7c),
    [0xff, 0xd9]
  )

/** RIFF, the declared container length, WEBP, and a VP8 chunk with its payload. */
const webp = (payload = 32): Uint8Array => {
  const body = concat(ascii('WEBP'), ascii('VP8 '), le32(payload), filler(payload, 0x5a))
  return concat(ascii('RIFF'), le32(body.length), body)
}

/** The type a valid inspection decided on. Throws if the bytes were refused. */
const accepted = (bytes: Uint8Array): ImageContentType => {
  const inspection = inspectImage(bytes)
  if (!inspection.ok) throw new Error(`expected acceptance, got ${inspection.code}`)
  return inspection.contentType
}

/** The rejection a refused inspection produced. Throws if the bytes were accepted. */
const refused = (bytes: Uint8Array) => {
  const inspection = inspectImage(bytes)
  if (inspection.ok) throw new Error(`expected rejection, got ${inspection.contentType}`)
  return inspection
}

/* ------------------------------- real files -------------------------------- */

describe('accepts what a real encoder produced', () => {
  it('reads public/brand-mark.png as a PNG of its exact size', () => {
    const bytes = realPng()
    const inspection = inspectImage(bytes)
    expect(inspection.ok).toBe(true)
    if (!inspection.ok) return
    expect(inspection.contentType).toBe('image/png')
    expect(inspection.size).toBe(bytes.length)
  })

  it('accepts the other shipped icons, so the e2e fixtures cannot be rejected', () => {
    for (const file of ['public/icons/icon-192.png', 'public/icons/icon-512.png']) {
      const bytes = new Uint8Array(readFileSync(path.join(process.cwd(), file)))
      expect(accepted(bytes), file).toBe('image/png')
    }
  })
})

/* ------------------------------ synthetic good ------------------------------ */

describe('accepts each supported format', () => {
  it('PNG, JPEG and WebP', () => {
    expect(accepted(png())).toBe('image/png')
    expect(accepted(jpeg())).toBe('image/jpeg')
    expect(accepted(webp())).toBe('image/webp')
  })

  it('every JPEG opening marker a real file can start with', () => {
    for (const marker of [0xe0, 0xe1, 0xee, 0xdb, 0xc0, 0xc2, 0xfe, 0xdd]) {
      const bytes = concat([0xff, 0xd8, 0xff, marker], filler(24, 0x11), [0xff, 0xd9])
      expect(accepted(bytes), `marker FF${marker.toString(16)}`).toBe('image/jpeg')
    }
  })

  it('all three WebP layouts', () => {
    for (const fourcc of ['VP8 ', 'VP8L', 'VP8X']) {
      const inner = concat(ascii(fourcc), le32(8), filler(8, 0x01))
      const riff = concat(ascii('RIFF'), le32(4 + inner.length), ascii('WEBP'), inner)
      expect(accepted(riff), fourcc).toBe('image/webp')
    }
  })

  /**
   * The cap is `> MAX_IMAGE_BYTES`, so a file of exactly 2 MB is the largest
   * legitimate upload. Pinned because the UI quotes the same number in its
   * pre-flight message and the route quotes it in the 413.
   */
  it('takes a file of exactly the limit and refuses one byte more', () => {
    const atLimit = png(MAX_IMAGE_BYTES - 45)
    expect(atLimit.length).toBe(MAX_IMAGE_BYTES)
    expect(accepted(atLimit)).toBe('image/png')

    const over = png(MAX_IMAGE_BYTES - 44)
    expect(over.length).toBe(MAX_IMAGE_BYTES + 1)
    const rejection = refused(over)
    expect(rejection.code).toBe('too_large')
    expect(rejection.message).toContain('2 MB')
  })
})

/* -------------------------------- rejections -------------------------------- */

describe('refuses anything that is not a supported image', () => {
  it('rejects empty input, including a null body', () => {
    for (const bytes of [new Uint8Array(0), null, undefined]) {
      expect(refused(bytes as Uint8Array).code, String(bytes)).toBe('empty')
    }
  })

  it('names the unsupported formats a person actually ends up choosing', () => {
    const cases: Array<[string, Uint8Array, string]> = [
      ['GIF', concat(ascii('GIF89a'), filler(64, 0)), 'Animated GIFs are not supported'],
      ['PDF', concat(ascii('%PDF-1.7'), filler(64, 0)), ''],
      [
        'SVG',
        concat(ascii('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')),
        '',
      ],
      ['HTML', concat(ascii('<!doctype html><html><body>hi</body></html>')), ''],
      ['EXE', concat([0x4d, 0x5a], filler(64, 0)), ''],
      ['plain text', concat(ascii('not an image at all')), ''],
    ]
    for (const [label, bytes, expected] of cases) {
      const rejection = refused(bytes)
      expect(rejection.code, label).toBe('unsupported')
      if (expected) expect(rejection.message, label).toContain(expected)
    }
  })

  it('rejects a PNG header glued in front of something else', () => {
    // The signature is present, so the PNG branch runs — and there is no IHDR at 12.
    const forged = concat(
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      ascii('<html>the rest is a document</html>')
    )
    const rejection = refused(forged)
    expect(rejection.code).toBe('unsupported')
    expect(rejection.message).toContain('PNG')
  })

  it('rejects a PNG whose declared IHDR length is not 13', () => {
    const bad = png()
    new DataView(bad.buffer).setUint32(8, 12, false)
    const rejection = refused(bad)
    expect(rejection.code).toBe('unsupported')
    expect(rejection.message).toContain('malformed')
  })

  it('rejects a truncated PNG — the signature is there and the tail is not', () => {
    const bytes = realPng()
    const rejection = refused(bytes.subarray(0, bytes.length - 24))
    expect(rejection.code).toBe('truncated')
    expect(rejection.message).toContain('incomplete')
  })

  it('rejects a JPEG with no end-of-image marker, and one with a nonsense marker', () => {
    const cut = jpeg()
    expect(refused(cut.subarray(0, cut.length - 2)).code).toBe('truncated')

    const nonsense = concat([0xff, 0xd8, 0xff, 0x00], filler(32, 0x41))
    const rejection = refused(nonsense)
    expect(rejection.code).toBe('unsupported')
    expect(rejection.message).toContain('JPEG')
  })

  it('rejects a WebP with an unknown chunk, a bad fourcc, or data after the image', () => {
    expect(
      refused(concat(ascii('RIFF'), le32(12), ascii('WEBP'), ascii('VP99'), le32(0))).message
    ).toContain('unrecognised chunk')
    // RIFF is real, the brand is not WEBP: this module owns images, not video.
    expect(refused(concat(ascii('RIFF'), le32(8), ascii('AVI '), ascii('LIST'))).code).toBe(
      'unsupported'
    )

    const truncated = webp(40)
    expect(refused(truncated.subarray(0, truncated.length - 20)).code).toBe('truncated')

    // The declared length says one document; the buffer carries a second after it.
    expect(refused(concat(webp(16), jpeg(16))).message).toContain('unexpected data')
  })

  it('measures size before format, so an oversized file is never parsed further', () => {
    const huge = new Uint8Array(MAX_IMAGE_BYTES + 1024) // all zeroes: no signature at all
    expect(refused(huge).code).toBe('too_large')
  })
})

/* --------------------------- declared vs actual type ------------------------ */

describe('the type the uploader claimed is checked against the bytes', () => {
  it('accepts a matching claim, an empty claim, and the generic one a browser sends', () => {
    expect(declaredTypeMatches('image/png', 'image/png')).toBe(true)
    expect(declaredTypeMatches('image/jpeg', 'image/jpeg')).toBe(true)
    expect(declaredTypeMatches('', 'image/webp')).toBe(true)
    expect(declaredTypeMatches('application/octet-stream', 'image/webp')).toBe(true)
  })

  it('ignores parameters and case, which real headers carry', () => {
    expect(declaredTypeMatches('IMAGE/PNG; charset=binary', 'image/png')).toBe(true)
  })

  /**
   * A mismatch is the signature of a renamed file or a forged multipart part.
   * Refusing it is not the security control — the sniffed type is what gets
   * stored — but it stops a PNG-claiming JPEG from being served under a header
   * that contradicts its own content.
   */
  it('refuses a claim that contradicts the content', () => {
    expect(declaredTypeMatches('image/png', 'image/jpeg')).toBe(false)
    expect(declaredTypeMatches('image/webp', 'image/png')).toBe(false)
    expect(declaredTypeMatches('text/plain', 'image/png')).toBe(false)
    expect(declaredTypeMatches('image/svg+xml', 'image/png')).toBe(false)
  })
})

/* --------------------------------- budgets --------------------------------- */

describe('upload budgets', () => {
  it('gives a multipart body room for its boundaries on top of the image', () => {
    expect(MAX_IMAGE_BYTES).toBe(2 * 1024 * 1024)
    expect(MAX_MULTIPART_BODY_BYTES).toBe(MAX_IMAGE_BYTES + 256 * 1024)
    expect(MAX_MULTIPART_BODY_BYTES).toBeGreaterThan(MAX_IMAGE_BYTES)
  })
})
