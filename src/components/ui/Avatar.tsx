'use client'

import React, { useEffect, useState } from 'react'

interface AvatarProps {
  /** Fallback content and the accessible name of the picture. */
  name: string
  /**
   * Where the stored picture is served from — `user.avatarUrl`, which the server
   * derives from the persisted reference on the user document. Undefined is the
   * normal case for anybody who has never uploaded one, and renders the initial.
   */
  src?: string
  /**
   * `lg` is the profile page (64px, matching the circle it replaced) and `sm` is
   * the header (32px). Both keep the exact size, colour and type weight of the
   * markup they stand in for, so switching to an image changes nothing around it.
   */
  size?: 'sm' | 'lg'
  className?: string
}

const SIZES = {
  sm: 'h-8 w-8 text-xs',
  lg: 'h-16 w-16 text-xl',
} as const

/**
 * Avatar — a user's picture, or their initial when there is none.
 *
 * It exists because the same circle is drawn in more than one place (the header
 * account menu and the profile screen) and a profile picture has to appear in all
 * of them, unconditionally — a feature that shows on one screen and not the other
 * reads as a bug whatever the second screen was before.
 *
 * The fallback is not only for a missing picture. `onError` covers the case where
 * the URL is real but the bytes are not reachable — an offline tab, or a stale
 * reference held by a component that has not re-read the session yet. The initial
 * is always a correct rendering of the user, so a failed image load degrades to
 * the previous behaviour instead of to a broken-image glyph.
 */
export function Avatar({ name, src, size = 'sm', className = '' }: AvatarProps) {
  const [failed, setFailed] = useState(false)

  /*
   * A new picture must be tried again even if the previous one failed to load.
   * Without this, one offline image would pin the initial for the rest of the
   * session, including after a successful re-upload.
   */
  useEffect(() => {
    setFailed(false)
  }, [src])

  const initial = name.charAt(0).toUpperCase()
  const circle = `shrink-0 overflow-hidden rounded-full bg-decoricks-dark font-semibold text-white ${SIZES[size]}`
  const classes = className ? `${circle} ${className}` : circle

  // `?` is the header's long-standing answer for a user whose name is unknown,
  // and an empty name has to render *something* inside the circle rather than a
  // blank disc.
  if (!src || failed) {
    return (
      <span className={`flex items-center justify-center ${classes}`} data-avatar-fallback="true">
        {initial || '?'}
      </span>
    )
  }

  return (
    /*
     * A plain `<img>`, not `next/image`. The picture is served by an owner-checked
     * route that requires the session cookie, and the optimizer fetches the source
     * server-side without it — every avatar would come back 401. It also cannot
     * take the `blob:` preview URL the uploader uses, so the one component would
     * have to render both paths. Nothing to optimise here either: the file is
     * already capped at 2 MB and drawn at 32 or 64 CSS pixels.
     */
    // eslint-disable-next-line @next/next/no-img-element -- rationale above
    <img
      src={src}
      alt={name}
      width={size === 'lg' ? 64 : 32}
      height={size === 'lg' ? 64 : 32}
      onError={() => setFailed(true)}
      className={`block ${classes}`}
      data-avatar-image="true"
    />
  )
}
