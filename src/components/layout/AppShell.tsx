'use client'

import React from 'react'
import { Header } from './Header'
import { Sidebar } from './Sidebar'
import { MobileDrawer } from './MobileDrawer'
import { ShellLayoutProvider, useShellLayout } from './ShellLayoutContext'

/**
 * Shell — persistent application chrome.
 *
 * The sidebar offset is read from the `--shell-sidebar-offset` custom property,
 * which globals.css derives inside a media query. That matters: the offset used
 * to come from a JavaScript viewport check, so the server-rendered first paint
 * applied the 240px desktop gutter to a 320px phone and crushed the content into
 * 80px until hydration finished. CSS decides it instead, so the first frame is
 * already right and there is no reflow when React mounts.
 *
 * There is deliberately no route-change animation here. The shell used to run a
 * GSAP stagger over <main>'s children on every pathname change *and* every page
 * ran its own PageTransition stagger inside that, so one navigation animated
 * twice and read as a page reload.
 */
const Shell = ({ children }: { children: React.ReactNode }) => {
  const { isCollapsed } = useShellLayout()

  return (
    <div className="shell min-h-dvh bg-surface-app" data-collapsed={isCollapsed ? 'true' : 'false'}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-decoricks-dark focus:px-3 focus:py-2 focus:text-sm focus:text-white"
      >
        Skip to content
      </a>

      <Header />
      <Sidebar />
      <MobileDrawer />

      <main
        id="main-content"
        className="pt-header transition-[padding] duration-240 ease-standard"
        style={{ paddingLeft: 'var(--shell-sidebar-offset)' }}
      >
        <div className="page-max page-pad py-5 md:py-6">{children}</div>
      </main>
    </div>
  )
}

export const AppShell = ({ children }: { children: React.ReactNode }) => (
  <ShellLayoutProvider>
    <Shell>{children}</Shell>
  </ShellLayoutProvider>
)