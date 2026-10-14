'use client'

import { useEffect, type RefObject } from 'react'

/**
 * Keeps the chat panel filling the viewport below its top edge and pins the
 * composer above the mobile keyboard.
 *
 * The base size is CSS (`calc(100dvh …)`), which is correct on desktop and on
 * Android Chrome (where `dvh` already shrinks for the keyboard). iOS Safari does
 * not shrink `dvh` for the keyboard — it reports the space through
 * `visualViewport` instead — so when a keyboard opens (viewport height drops by
 * more than a threshold) we override with an explicit pixel height measured from
 * `visualViewport`. When the keyboard closes we clear the inline height and let
 * the CSS value win again, so there is never a stale transform or a jump.
 */
export function useKeyboardAwareHeight(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current
    if (!el || typeof window === 'undefined') return

    const vv = window.visualViewport
    if (!vv) return // no visualViewport support: pure CSS dvh is still correct

    const apply = () => {
      const keyboardOpen = window.innerHeight - vv.height > 120
      if (keyboardOpen) {
        const top = el.getBoundingClientRect().top
        el.style.height = `${Math.max(240, Math.round(vv.height - top))}px`
      } else {
        el.style.height = ''
      }
    }

    apply()
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
    }
  }, [ref])
}
