import React from 'react'

/**
 * BrandMark — the Decoricks monogram.
 *
 * Extracted so the sidebar (rail), mobile drawer and drawer header all render an
 * identical mark. It uses only brand colours and contains no gradient, which
 * keeps it legible at 24px against both the raised and inverse surfaces.
 */
export const BrandMark = ({ size = 26 }: { size?: number }) => (
  <span
    aria-hidden="true"
    className="flex shrink-0 items-center justify-center rounded-md bg-decoricks-dark font-semibold leading-none text-white"
    style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
  >
    D
  </span>
)