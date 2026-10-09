'use client'

import React from 'react'

interface PageTransitionProps {
  children: React.ReactNode
  className?: string
  /** Retained for call-site compatibility; no longer has any effect. */
  stagger?: boolean
}

/**
 * PageTransition — layout passthrough.
 *
 * This used to run a GSAP enter animation over a page's children. Combined with
 * the shell's own route-change stagger, every navigation animated twice and read
 * as a full page reload. Content now appears immediately and only genuinely
 * asynchronous things (data) show a loading state.
 *
 * The component is kept so the ~10 call sites do not need churn, and it still
 * honours the `className` each page passed (which carries the page max-width).
 */
export const PageTransition = ({ children, className = '' }: PageTransitionProps) => (
  <div className={className}>{children}</div>
)