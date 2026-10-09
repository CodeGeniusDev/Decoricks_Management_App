'use client'

import React, { useEffect, useRef } from 'react'
import { gsap } from 'gsap'

/**
 * GSAP entrance helpers.
 *
 * Phase 1 removed animation entirely, which made every route change feel like a
 * hard cut. These reintroduce motion without reintroducing the problems:
 *
 *   - Nothing animates layout-affecting properties (no width/height/top/left),
 *     so there is no reflow and no cumulative layout shift.
 *   - Every tween is killed on unmount, and `gsap.context` reverts inline styles
 *     it set, so navigating away mid-animation cannot leave a half-faded
 *     element behind or trigger a remount.
 *   - `ScrollTrigger` is deliberately not used: it needs a plugin, adds a
 *     scroll listener on every page, and buys nothing for a fade-in.
 *   - `prefers-reduced-motion` short-circuits to "set the final state and stop",
 *     so the UI is fully usable with animation disabled.
 */

export const prefersReducedMotion = (): boolean => {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Subtle, fast. Anything slower reads as sluggish on an internal tool. */
export const DURATION = 0.24
export const STAGGER = 0.035

/**
 * Page-level fade + rise for a screen's top-level sections.
 *
 * `y` is used rather than `scale` because a scale transform on a large panel
 * changes its rendered size during the tween, which is the kind of thing that
 * reads as a layout jump.
 */
export const usePageEnter = (
  scope: React.RefObject<HTMLElement | null>,
  deps: React.DependencyList = []
) => {
  useEffect(() => {
    const root = scope.current
    if (!root) return

    if (prefersReducedMotion()) {
      gsap.set(root, { opacity: 1, y: 0 })
      return
    }

    const ctx = gsap.context(() => {
      const targets = root.querySelectorAll('[data-animate]')
      if (targets.length === 0) {
        gsap.fromTo(root, { opacity: 0 }, { opacity: 1, duration: DURATION, ease: 'power2.out' })
        return
      }

      gsap.fromTo(
        targets,
        { opacity: 0, y: 8 },
        {
          opacity: 1,
          y: 0,
          duration: DURATION,
          ease: 'power2.out',
          stagger: STAGGER,
          // `clearProps` guarantees the end state is plain CSS, so a re-render
          // or a re-mount is never fighting an inline transform.
          clearProps: 'transform,opacity,willChange',
        }
      )
    }, root)

    return () => ctx.revert()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

/**
 * Entrance for a one-off surface (login card, empty state) that is not part of
 * a repeating list.
 */
export const useRevealOnMount = <T extends HTMLElement>(ref: React.RefObject<T | null>) => {
  useEffect(() => {
    const el = ref.current
    if (!el) return

    if (prefersReducedMotion()) {
      gsap.set(el, { opacity: 1, y: 0 })
      return
    }

    const tween = gsap.fromTo(
      el,
      { opacity: 0, y: 10 },
      {
        opacity: 1,
        y: 0,
        duration: 0.3,
        ease: 'power2.out',
        clearProps: 'transform,opacity,willChange',
      }
    )

    return () => {
      tween.kill()
    }
  }, [ref])
}

/**
 * Drawer/panel transition. `open` drives the tween; a change mid-flight is
 * reversed from the current position rather than snapped, which is what keeps
 * a fast open/close from flickering.
 */
export const useSlideTransition = (
  ref: React.RefObject<HTMLElement | null>,
  open: boolean,
  axis: 'x' | 'y' = 'x'
) => {
  const hasRendered = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    if (prefersReducedMotion()) {
      gsap.set(el, { opacity: open ? 1 : 0, x: 0, y: 0, pointerEvents: open ? 'auto' : 'none' })
      return
    }

    const ctx = gsap.context(() => {
      if (!hasRendered.current) {
        hasRendered.current = true
        gsap.set(el, { opacity: 0, [axis]: open ? 0 : 16, pointerEvents: open ? 'auto' : 'none' })
        if (!open) return
      }

      gsap.to(el, {
        opacity: open ? 1 : 0,
        [axis]: 0,
        duration: DURATION,
        ease: 'power2.out',
        pointerEvents: open ? 'auto' : 'none',
        overwrite: 'auto',
      })
    }, el)

    return () => ctx.revert()
  }, [ref, open, axis])
}

/**
 * Button/icon micro-interaction: a short press dip.
 *
 * Deliberately not a hover lift — the reference design is flat, and a moving
 * control is one that can be mis-tapped on mobile.
 */
export const usePressScale = <T extends HTMLElement>(ref: React.RefObject<T | null>) => {
  useEffect(() => {
    const el = ref.current
    if (!el || prefersReducedMotion()) return

    const press = gsap.to(el, { scale: 0.97, duration: 0.09, ease: 'power2.out', overwrite: 'auto' })
    const release = gsap.to(el, { scale: 1, duration: 0.16, ease: 'power2.out', overwrite: 'auto' })

    const onDown = () => press.play()
    const onUp = () => release.play()

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointerleave', onUp)
    el.addEventListener('pointercancel', onUp)

    return () => {
      press.kill()
      release.kill()
      gsap.set(el, { clearProps: 'transform' })
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointerleave', onUp)
      el.removeEventListener('pointercancel', onUp)
    }
  }, [ref])
}

/** Toast entrance/exit. Returns the timeline so callers can chain dismissal. */
export const toastIn = (el: HTMLElement): gsap.core.Tween =>
  gsap.fromTo(
    el,
    { opacity: 0, y: -8 },
    { opacity: 1, y: 0, duration: 0.22, ease: 'power2.out', clearProps: 'transform,opacity' }
  )

export const toastOut = (el: HTMLElement): gsap.core.Tween =>
  gsap.to(el, { opacity: 0, y: -8, duration: 0.18, ease: 'power2.in' })

/**
 * Modal backdrop + panel. Kept as a timeline so the backdrop can fade while the
 * panel rises, without two competing tweens fighting over the same element.
 */
export const modalIn = (backdrop: HTMLElement, panel: HTMLElement): gsap.core.Timeline => {
  if (prefersReducedMotion()) {
    gsap.set([backdrop, panel], { opacity: 1, y: 0 })
    return gsap.timeline()
  }

  return gsap
    .timeline()
    .fromTo(backdrop, { opacity: 0 }, { opacity: 1, duration: 0.16, ease: 'power2.out' }, 0)
    .fromTo(
      panel,
      { opacity: 0, y: 12, scale: 0.985 },
      {
        opacity: 1,
        y: 0,
        scale: 1,
        duration: 0.22,
        ease: 'power2.out',
        clearProps: 'transform,opacity',
      },
      0.04
    )
}

export const modalOut = (backdrop: HTMLElement, panel: HTMLElement): gsap.core.Timeline => {
  if (prefersReducedMotion()) return gsap.timeline()

  return gsap
    .timeline()
    .to(panel, { opacity: 0, y: 8, duration: 0.14, ease: 'power2.in' })
    .to(backdrop, { opacity: 0, duration: 0.14, ease: 'power2.in' }, 0)
}