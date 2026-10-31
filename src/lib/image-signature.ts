/**
 * Profile-picture content validation.
 *
 * The upload path cannot rely on a file name or on the `Content-Type` a browser
 * puts on a multipart part: both are chosen by the client and are trivially
 * forged, so a PDF, an SVG full of script or a JPEG header glued in front of
 * arbitrary bytes would all be accepted and then served back to every tab of
 * this origin. What is actually in the bytes is the only evidence worth having,
 * so this module reads the signature and a little structure around it, and the
 * stored content type is the value decided HERE rather than anything the client
 * claimed.
 *
 * Deliberately no new dependency: `sharp` would let us re-encode and downscale,
 * but it is a native binary on a free-tier host, and the brief asks for
 * validation rather than transformation. Everything below is a bounded scan of
 * the bytes we already have.
 */

/** Accepted content types. The stored value is one of these, never client input. */
export type ImageContentType = 'image/jpeg' | 'image/png' | 'image/webp'

/**
 * Ceiling on an upload, and the reason it is a ceiling rather than a suggestion:
 * a profile picture is one small image per person, and this database is a free
 * Atlas M0 instance with a 512 MB budget that currently holds every financial
 * record the business has. Uncapped, four team members could fill it with
 * camera originals.
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024

/**
 * Slack over {@link MAX_IMAGE_BYTES} for a multipart request, whose body carries
 * the boundary markers, the part headers and the file name on top of the image.
 * Used to refuse an obviously enormous body before its bytes are buffered.
 */
export const MAX_MULTIPART_BODY_BYTES = MAX_IMAGE_BYTES + 256 * 1024

/** How close to the end of the file a terminating marker is still expected. */
const TRAILING_TOLERANCE_BYTES = 4096

export type ImageRejectionCode = 'empty' | 'too_large' | 'unsupported' | 'truncated' | 'corrupt'

export type ImageInspection =
  | { ok: true; contentType: ImageContentType; size: number }
  | { ok: false; code: ImageRejectionCode; message: string }

const ACCEPTED_MESSAGE = 'Only JPEG, PNG and WebP images are supported.'

const tooLarge = (): ImageInspection => ({
  ok: false,
  code: 'too_large',
  message: `Image is too large. The maximum size is ${Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))} MB.`,
})

const unsupported = (message = ACCEPTED_MESSAGE): ImageInspection => ({
  ok: false,
  code: 'unsupported',
  message,
})

const truncated = (format: string): ImageInspection => ({
  ok: false,
  code: 'truncated',
  message: `That ${format} file looks incomplete. Try exporting or choosing it again.`,
})

/** `bytes[offset..]` equals `signature`? */
const hasPrefix = (bytes: Uint8Array, signature: number[], offset = 0): boolean => {
  if (bytes.length < offset + signature.length) return false
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false
  }
  return true
}

/** `bytes[offset..]` equals the ASCII `text`? */
const hasText = (bytes: Uint8Array, text: string, offset: number): boolean => {
  if (bytes.length < offset + text.length) return false
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false
  }
  return true
}

/** Big-endian unsigned 32-bit integer at `offset` (PNG chunk lengths). */
const readUInt32BE = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]) >>>
  0

/** Little-endian unsigned 32-bit integer at `offset` (RIFF chunk lengths). */
const readUInt32LE = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset + 3] << 24) | (bytes[offset + 2] << 16) | (bytes[offset + 1] << 8) | bytes[offset]

/** Is `needle` present in the last `window` bytes of the file? */
const endsWithNear = (bytes: Uint8Array, needle: number[], window: number): boolean => {
  const start = Math.max(0, bytes.length - window)
  for (let i = bytes.length - needle.length; i >= start; i -= 1) {
    if (hasPrefix(bytes, needle, i)) return true
  }
  return false
}

/**
 * JPEG: `FF D8` starts the file, and the marker immediately after it says what
 * kind of segment follows. `FF D9` ends it. Requiring both rejects the two
 * shapes that actually matter — a file that is only the first kilobytes of an
 * image, and a file that begins like a JPEG in order to get past a signature
 * check and then carries something else.
 */
const inspectJpeg = (bytes: Uint8Array): ImageInspection => {
  // Marker codes that legitimately open a JPEG: APPn (EXIF/JFIF), COM, DQT, DHT,
  // the SOF family, RSTn/SOI/EOI, and the start-of-scan codes.
  const opener = bytes[3] ?? 0
  const appn = opener >= 0xe0 && opener <= 0xef
  const sof = (opener >= 0xc0 && opener <= 0xc3) || (opener >= 0xc5 && opener <= 0xc7)
  const sof2 = (opener >= 0xc9 && opener <= 0xcb) || opener === 0xcd || opener === 0xce
  const plausible = appn || sof || sof2 || opener === 0xfe || opener === 0xdb || opener === 0xdd

  if (!plausible) {
    return unsupported('That does not look like a readable JPEG.')
  }
  // Real encoders close the scan; a missing EOI means the download was cut short.
  if (!endsWithNear(bytes, [0xff, 0xd9], TRAILING_TOLERANCE_BYTES)) {
    return truncated('JPEG')
  }
  return { ok: true, contentType: 'image/jpeg', size: bytes.length }
}

/**
 * PNG: the 8-byte signature, then the first chunk MUST be `IHDR` with a declared
 * length of exactly 13, and `IEND` (with its fixed CRC) closes the stream. A file
 * that only pastes the signature in front of other bytes fails at the `IHDR`
 * check, and one that is cut off mid-pixel-data fails at `IEND`.
 */
const inspectPng = (bytes: Uint8Array): ImageInspection => {
  if (!hasText(bytes, 'IHDR', 12)) return unsupported('That does not look like a readable PNG.')
  if (readUInt32BE(bytes, 8) !== 13) return unsupported('That PNG header is malformed.')
  // IEND is an empty chunk: four length bytes of zero, 'IEND', then a fixed CRC.
  if (
    !endsWithNear(bytes, [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82], TRAILING_TOLERANCE_BYTES)
  ) {
    return truncated('PNG')
  }
  return { ok: true, contentType: 'image/png', size: bytes.length }
}

/**
 * WebP: `RIFF … WEBP`, and the format fourcc after that says which of the three
 * real WebP layouts follows. The declared RIFF length is checked against the
 * actual byte count (tolerating the one padding byte the spec allows on odd
 * sizes), because that single number is what catches a truncated export and an
 * image with a second document appended after it.
 */
const inspectWebp = (bytes: Uint8Array): ImageInspection => {
  if (!hasText(bytes, 'WEBP', 8)) return unsupported('That does not look like a readable WebP.')

  const fourcc = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0)
  if (fourcc !== 'VP8 ' && fourcc !== 'VP8L' && fourcc !== 'VP8X') {
    return unsupported('That WebP file has an unrecognised chunk.')
  }

  const declared = readUInt32LE(bytes, 4)
  if (!Number.isFinite(declared) || declared < 6)
    return unsupported('That WebP header is malformed.')

  const actual = bytes.length - 8
  if (actual > declared + 1) {
    return unsupported('That WebP file has unexpected data after the image.')
  }
  if (actual < declared) return truncated('WebP')

  return { ok: true, contentType: 'image/webp', size: bytes.length }
}

/**
 * What this byte string actually is, or why it cannot be stored.
 *
 * Order matters: size first (cheapest bound, and it must be enforced before
 * anything writes to the database), then the signature, then the per-format
 * structure. `contentTypeHint` is only ever used to make a refusal message more
 * useful — it never lets a format through.
 */
export const inspectImage = (
  bytes: Uint8Array | null | undefined,
  maxBytes: number = MAX_IMAGE_BYTES
): ImageInspection => {
  if (!bytes || bytes.length === 0) {
    return { ok: false, code: 'empty', message: 'No image data was received.' }
  }
  if (bytes.length > maxBytes) return tooLarge()

  if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) return inspectJpeg(bytes)
  if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return inspectPng(bytes)
  if (hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) && hasText(bytes, 'WEBP', 8))
    return inspectWebp(bytes)

  // A `GIF8` / `<svg` / `%PDF` prefix is not a supported format; the named hints
  // exist because "only JPEG, PNG and WebP" is a more actionable answer than a
  // generic rejection when the user is holding an animated GIF.
  if (hasText(bytes, 'GIF8', 0)) {
    return unsupported('Animated GIFs are not supported. Choose a JPEG, PNG or WebP image.')
  }
  return unsupported()
}

/**
 * The declared MIME type is checked against the sniffed content type.
 *
 * It is not the authority — `inspectImage` is — but a part that claims
 * `image/png` and sniffs as a JPEG is either a renamed file or a forged part,
 * and refusing the mismatch costs nothing while closing a class of "the browser
 * later disagrees with our Content-Type" surprises.
 */
export const declaredTypeMatches = (declared: string, actual: ImageContentType): boolean => {
  const normalised = (declared || '').split(';')[0].trim().toLowerCase()
  if (!normalised || normalised === 'application/octet-stream') return true
  return normalised === actual
}
