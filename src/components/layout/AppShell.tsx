'use client'

import React, { useRef, useEffect } from 'react'
import { animations, cleanupAnimations } from '@/lib/animations'
import { Header } from './Header'
import { Sidebar } from './Sidebar'
import { MobileNav } from './MobileNav'

interface AppShellProps {
  children: React.ReactNode
}

export const AppShell = ({ children }: AppShellProps) => {
  const mainRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const main = mainRef.current
    if (!main) return

    // Animate page content entry with stagger
    const contentBlocks = Array.from(main.querySelectorAll('section > *'))
    if (contentBlocks.length > 0) {
      animations.contentBlockStagger(contentBlocks, 0.3, 0.05)
    } else {
      // Fallback: animate the main container
      animations.fadeInUp(main, 0.5, 0.1)
    }

    return () => {
      cleanupAnimations(main)
      contentBlocks.forEach((block) => cleanupAnimations(block))
    }
  }, [])

  return (
    <div className="min-h-screen bg-decoricks-light">
      <Header />
      <Sidebar />
      <MobileNav />

      {/* Main Content */}
      <main ref={mainRef} className="pt-16 lg:pl-64 pb-20 lg:pb-6 px-4 lg:px-6">
        {children}
      </main>
    </div>
  )
}
