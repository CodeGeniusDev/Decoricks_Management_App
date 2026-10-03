'use client'

import React, { useRef, useEffect } from 'react'
import { AppShell } from '@/components/layout/AppShell'
import { animations, cleanupAnimations } from '@/lib/animations'

export default function Home() {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Staggered animation for dashboard content blocks
    const blocks = Array.from(container.querySelectorAll('h1, .dashboard-blocks > *'))
    animations.contentBlockStagger(blocks, 0.3, 0.08)

    return () => {
      blocks.forEach((block) => cleanupAnimations(block))
    }
  }, [])

  return (
    <AppShell>
      <div ref={containerRef} className="max-w-7xl mx-auto">
        <h1 className="text-2xl font-bold text-decoricks-dark mb-6">Dashboard</h1>
        <div className="dashboard-blocks flex flex-col items-center py-12">
          <p className="text-decoricks-dark/60">Dashboard placeholder - coming in Phase 2</p>
        </div>
      </div>
    </AppShell>
  )
}
