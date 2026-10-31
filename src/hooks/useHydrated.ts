'use client'

import { useEffect, useState } from 'react'

/**
 * Has this component's own event handlers been attached yet?
 *
 * Server-rendered HTML is readable and typable long before React has hydrated,
 * and an ordinary `<form>` in that window is a live native form: clicking its
 * submit button or pressing Enter in a field performs a real browser
 * navigation, serialising every named input into the URL. `onSubmit` cannot
 * prevent what it has not been attached to yet. Disabling the submit control
 * until after the first passive effect closes that window — React attaches
 * event listeners during commit, and passive effects run after it, so by the
 * time this returns `true` the handler exists.
 *
 * Starts `false` on both the server and the first client render, so there is no
 * hydration mismatch; the correction happens in the effect.
 *
 * A form that only ever appears after a click (a modal opened by state) cannot
 * be submitted before hydration and does not need this. A form in the initial
 * HTML of a page does — and every form still declares `method="post"`, so a
 * navigation in this window can never put a field value in a URL either way.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    setHydrated(true)
  }, [])

  return hydrated
}
