'use client'

import React, { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { animations, cleanupAnimations } from '@/lib/animations'

interface NavItem {
  name: string
  href: string
}

const navItems: NavItem[] = [
  { name: 'Dashboard', href: '/' },
  { name: 'Finance', href: '/finance' },
  { name: 'Budgets', href: '/budgets' },
  { name: 'Inventory', href: '/inventory' },
  { name: 'Sales', href: '/sales' },
  { name: 'Tasks', href: '/tasks' },
  { name: 'Chat', href: '/chat' },
  { name: 'Suppliers', href: '/suppliers' },
  { name: 'Settings', href: '/settings' },
  { name: 'Weekly Summary', href: '/weekly-summary' },
]

export const MobileNav = () => {
  const pathname = usePathname()
  const [isOpen, setIsOpen] = useState(false)
  const navBarRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Animate bottom nav bar entry
  useEffect(() => {
    const navBar = navBarRef.current
    if (!navBar) return

    animations.fadeInUp(navBar, 0.4, 0.1)

    return () => {
      cleanupAnimations(navBar)
    }
  }, [])

  // Animate full-screen menu entry/exit
  useEffect(() => {
    if (!menuRef.current) return

    if (isOpen) {
      document.body.style.overflow = 'hidden'
      const links = Array.from(menuRef.current.querySelectorAll('a'))
      animations.staggerFadeIn(links, 0.2, 0.05)
    } else {
      document.body.style.overflow = 'unset'
    }

    return () => {
      document.body.style.overflow = 'unset'
    }
  }, [isOpen])

  return (
    <>
      {/* Bottom Navigation Bar */}
      <div
        ref={navBarRef}
        className="fixed bottom-0 left-0 right-0 glass border-t border-decoricks-black/10 lg:hidden z-40"
      >
        <div className="flex items-center justify-around">
          <Link
            href="/"
            className={`flex flex-col items-center py-2 px-3 min-h-[44px] min-w-[44px] ${
              pathname === '/' ? 'text-decoricks-brown' : 'text-decoricks-dark/60'
            }`}
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
            <span className="text-xs mt-1">Home</span>
          </Link>

          <Link
            href="/finance"
            className={`flex flex-col items-center py-2 px-3 min-h-[44px] min-w-[44px] ${
              pathname.startsWith('/finance') ? 'text-decoricks-brown' : 'text-decoricks-dark/60'
            }`}
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 0 0118 0z" />
            </svg>
            <span className="text-xs mt-1">Finance</span>
          </Link>

          <Link
            href="/inventory"
            className={`flex flex-col items-center py-2 px-3 min-h-[44px] min-w-[44px] ${
              pathname.startsWith('/inventory') ? 'text-decoricks-brown' : 'text-decoricks-dark/60'
            }`}
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
            <span className="text-xs mt-1">Stock</span>
          </Link>

          <Link
            href="/tasks"
            className={`flex flex-col items-center py-2 px-3 min-h-[44px] min-w-[44px] ${
              pathname.startsWith('/tasks') ? 'text-decoricks-brown' : 'text-decoricks-dark/60'
            }`}
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
            <span className="text-xs mt-1">Tasks</span>
          </Link>

          <button
            onClick={() => setIsOpen(true)}
            className="flex flex-col items-center py-2 px-3 min-h-[44px] min-w-[44px] text-decoricks-dark/60"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            <span className="text-xs mt-1">Menu</span>
          </button>
        </div>
      </div>

      {/* Full Screen Menu */}
      {isOpen && (
        <div ref={menuRef} className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-decoricks-black/50 backdrop-blur-sm"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute right-0 top-0 bottom-0 w-64 glass p-4">
            <div className="flex items-center justify-between mb-6">
              <span className="text-lg font-semibold text-decoricks-dark">Menu</span>
              <button
                onClick={() => setIsOpen(false)}
                className="p-2 rounded-lg hover:bg-decoricks-dark/10 text-decoricks-dark min-h-[36px] min-w-[36px]"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <nav className="space-y-1">
              {navItems.map((item) => {
                const isActive = pathname === item.href || pathname.startsWith(item.href + '/')
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setIsOpen(false)}
                    className={`
                      block px-3 py-2 rounded-lg transition-colors min-h-[44px]
                      ${isActive ? 'bg-decoricks-brown text-decoricks-light' : 'text-decoricks-dark hover:bg-decoricks-dark/10'}
                    `}
                  >
                    {item.name}
                  </Link>
                )
              })}
            </nav>
          </div>
        </div>
      )}
    </>
  )
}
