'use client'

import React, { useState, useEffect, useRef } from 'react'
import { animations, cleanupAnimations } from '@/lib/animations'

export const Header = () => {
  const [isOnline, setIsOnline] = useState(true)
  const headerRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const header = headerRef.current
    if (!header) return

    // Animate header entry
    animations.headerEnter(header)

    return () => {
      cleanupAnimations(header)
    }
  }, [])

  useEffect(() => {
    setIsOnline(navigator.onLine)
    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  return (
    <header
      ref={headerRef}
      className="fixed top-0 left-0 right-0 h-16 glass border-b border-decoricks-black/10 z-30 lg:pl-64"
    >
      <div className="flex items-center justify-between h-full px-4 lg:px-6">
        {/* Mobile menu button - hidden on desktop */}
        <div className="lg:hidden">
          <button className="p-2 rounded-lg hover:bg-decoricks-dark/10 text-decoricks-dark min-h-[36px] min-w-[36px]">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        </div>

        {/* Logo */}
        <h1 className="text-lg font-semibold text-decoricks-dark">Decoricks Management</h1>

        {/* Right side */}
        <div className="flex items-center gap-4">
          {/* Online/Offline Status */}
          <div className="flex items-center gap-2">
            <div
              className={`w-2 h-2 rounded-full ${
                isOnline ? 'bg-green-500' : 'bg-red-500'
              }`}
              aria-hidden="true"
            />
            <span className="text-sm text-decoricks-dark hidden sm:inline">
              {isOnline ? 'Online' : 'Offline'}
            </span>
          </div>

          {/* User Avatar (placeholder) */}
          <div className="w-10 h-10 rounded-full bg-decoricks-brown text-decoricks-light flex items-center justify-center font-semibold min-h-[40px] min-w-[40px]">
            A
          </div>
        </div>
      </div>
    </header>
  )
}
