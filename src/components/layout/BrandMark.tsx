import React from 'react'

/**
 * BrandMark — the Decoricks badge.
 *
 * It is the app icon itself (`/public/brand-mark.png`, cut from the same master
 * artwork as `/favicon.ico` and `/icons/*`), so the mark in the chrome and the
 * icon a user installs on a home screen are one drawing rather than two. The
 * artwork carries its own circle, ring and palette, so it needs no background,
 * border or rounding here — it reads on both the raised and inverse surfaces.
 *
 * A plain `<img>` rather than `next/image`, deliberately: this is one fixed
 * small asset served straight out of `/public`, which puts it inside the
 * service worker's shell precache. The optimised `/_next/image` URL is not
 * precached, so the brand mark would be blank in an installed app opened
 * offline — the exact case Phase 9 exists for.
 *
 * Decorative on purpose. Every caller sits next to the word "Decoricks", so the
 * image is hidden from the accessibility tree instead of announcing the brand
 * twice per screen.
 *
 * `max-w-none` is a guard, and it is here because of a bug that already shipped.
 * Tailwind Preflight carries `img, video { max-width: 100%; height: auto }`. The
 * inline `height` below beats Preflight's `height: auto`, but an inline `width`
 * does NOT beat `max-width: 100%` — the cap is applied after the used width is
 * resolved. In a container narrower than the mark (the collapsed 64px rail once
 * gave the badge 7px) that pins width to the container and leaves height at
 * 24px, and `object-fit: fill` draws a square artwork into a 7×24 box: a
 * vertical ellipse. `shrink-0` cannot prevent it, because the constraint is not
 * flex shrinking.
 *
 * Narrowing the rail's brand row is what actually fixed the reported bug — with
 * the row 24px wide the cap is inert, which is measured. This line stays so the
 * mark can never be the thing that breaks when someone else puts it in a tight
 * container.
 */
export const BrandMark = ({ size = 26 }: { size?: number }) => (
  // eslint-disable-next-line @next/next/no-img-element -- rationale above
  <img
    src="/brand-mark.png"
    alt=""
    aria-hidden="true"
    width={size}
    height={size}
    className="max-w-none shrink-0 select-none"
    style={{ width: size, height: size }}
  />
)
