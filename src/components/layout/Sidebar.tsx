'use client'

import React, { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { animations, cleanupAnimations } from '@/lib/animations'

interface NavItem {
  name: string
  href: string
  icon?: React.ReactNode
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

export const Sidebar = () => {
  const pathname = usePathname()
  const [isCollapsed, setIsCollapsed] = useState(false)
  const sidebarRef = useRef<HTMLElement>(null)
  const navItemsRef = useRef<(HTMLAnchorElement | null)[]>([])

  useEffect(() => {
    const sidebar = sidebarRef.current
    if (!sidebar) return

    // Animate sidebar entry
    animations.fadeInLeft(sidebar, 0.5, 0)

    // Animate nav items with stagger
    const items = navItemsRef.current.filter(Boolean) as HTMLAnchorElement[]
    animations.staggerFadeIn(items, 0.3, 0.05)

    return () => {
      cleanupAnimations(sidebar)
      items.forEach((item) => cleanupAnimations(item))
    }
  }, [])

  useEffect(() => {
    const sidebar = sidebarRef.current
    if (!sidebar) return

    if (isCollapsed) {
      animations.sidebarCollapse(sidebar)
    } else {
      animations.sidebarExpand(sidebar)
    }
  }, [isCollapsed])

  return (
    <aside
      ref={sidebarRef}
      className={`
        fixed left-0 top-0 h-full glass border-r border-decoricks-black/10 z-40
        transition-all duration-300 ease-in-out
        ${isCollapsed ? 'w-16' : 'w-64'}
        hidden lg:block
      `}
    >
      {/* Logo */}
      <div className="flex items-center justify-between p-4 border-b border-decoricks-black/10">
        {!isCollapsed && (
          <span className="text-lg font-semibold text-decoricks-dark">Decoricks</span>
        )}
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="p-2 rounded-lg hover:bg-decoricks-dark/10 text-decoricks-dark min-h-[36px] min-w-[36px]"
          aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            {isCollapsed ? (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7M19 19l-7-7 7-7" />
            )}
          </svg>
        </button>
      </div>

      {/* Navigation */}
      <nav className="p-4 space-y-1">
        {navItems.map((item, index) => {
          const isActive = pathname === item.href || pathname.startsWith(item.href + '/')
          return (
            <Link
              key={item.href}
              href={item.href}
              ref={(el) => (navItemsRef.current[index] = el)}
              className={`
                flex items-center gap-3 px-3 py-2 rounded-lg transition-colors min-h-[44px]
                ${isActive ? 'bg-decoricks-brown text-decoricks-light' : 'text-decoricks-dark hover:bg-decoricks-dark/10'}
              `}
            >
              {item.icon && <span className="flex-shrink-0">{item.icon}</span>}
              {!isCollapsed && <span className="font-medium">{item.name}</span>}
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
