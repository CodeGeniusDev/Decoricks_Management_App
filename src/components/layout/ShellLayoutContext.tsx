'use client'

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

/**
 * ShellLayoutState — navigation chrome state shared by Sidebar, Header,
 * MobileDrawer and AppShell.
 *
 * The sidebar collapse state used to live inside <Sidebar>, so the header and
 * <main> could not react to it: the rail narrowed to 64px while the content kept
 * its 256px offset, leaving a dead gutter that snapped shut on expand. Hoisting
 * the state here lets every dependent element react together.
 *
 * Deliberately NOT exposed: the current viewport breakpoint. Layout offsets are
 * derived from CSS in globals.css (`.shell`), because anything that depends on a
 * post-hydration matchMedia is wrong for the first paint on a phone. Only state
 * that genuinely cannot be expressed in CSS belongs here.
 */
interface ShellLayoutState {
  isCollapsed: boolean
  toggleCollapsed: () => void
  isDrawerOpen: boolean
  openDrawer: () => void
  closeDrawer: () => void
  toggleDrawer: () => void
}

const ShellLayoutContext = createContext<ShellLayoutState | null>(null)

/** Below this width the sidebar is replaced by the drawer. Matches `lg`. */
const DESKTOP_QUERY = '(min-width: 1024px)'

export function ShellLayoutProvider({ children }: { children: React.ReactNode }) {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)

  // A drawer left open while the viewport grows would sit on top of the real
  // sidebar, so close it on the way to desktop. Purely a corrective side effect;
  // no layout is derived from it.
  useEffect(() => {
    const mql = window.matchMedia(DESKTOP_QUERY)
    const handleChange = (event: MediaQueryListEvent) => {
      if (event.matches) setIsDrawerOpen(false)
    }
    mql.addEventListener('change', handleChange)
    return () => mql.removeEventListener('change', handleChange)
  }, [])

  const toggleCollapsed = useCallback(() => setIsCollapsed((v) => !v), [])
  const openDrawer = useCallback(() => setIsDrawerOpen(true), [])
  const closeDrawer = useCallback(() => setIsDrawerOpen(false), [])
  const toggleDrawer = useCallback(() => setIsDrawerOpen((v) => !v), [])

  const value = useMemo<ShellLayoutState>(
    () => ({
      isCollapsed,
      toggleCollapsed,
      isDrawerOpen,
      openDrawer,
      closeDrawer,
      toggleDrawer,
    }),
    [isCollapsed, toggleCollapsed, isDrawerOpen, openDrawer, closeDrawer, toggleDrawer]
  )

  return <ShellLayoutContext.Provider value={value}>{children}</ShellLayoutContext.Provider>
}

export function useShellLayout(): ShellLayoutState {
  const ctx = useContext(ShellLayoutContext)
  if (!ctx) {
    throw new Error('useShellLayout must be used inside <ShellLayoutProvider>')
  }
  return ctx
}