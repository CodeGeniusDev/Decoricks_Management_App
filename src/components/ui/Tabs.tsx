'use client'

import React, { useState, useRef, useEffect } from 'react'
import { animations, cleanupAnimations } from '@/lib/animations'

interface TabsProps {
  tabs: Array<{ id: string; label: string }>
  defaultTab?: string
  children: (activeTab: string) => React.ReactNode
}

export const Tabs = ({ tabs, defaultTab, children }: TabsProps) => {
  const [activeTab, setActiveTab] = useState(defaultTab || tabs[0]?.id)
  const tabsRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const tabsEl = tabsRef.current
    if (!tabsEl) return

    // Animate tabs bar entry
    animations.fadeInDown(tabsEl, 0.3, 0)

    return () => {
      cleanupAnimations(tabsEl)
    }
  }, [])

  const handleTabChange = (newTab: string) => {
    const content = contentRef.current
    if (content) {
      animations.fadeIn(content, 0.3, 0)
    }
    setActiveTab(newTab)
  }

  return (
    <div>
      <div
        ref={tabsRef}
        className="flex border-b-2 border-decoricks-dark/20"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => handleTabChange(tab.id)}
            className={`
              px-4 py-2 text-sm font-medium rounded-t-lg min-h-[44px] min-w-[44px]
              transition-all duration-200
              ${
                activeTab === tab.id
                  ? 'bg-decoricks-brown text-decoricks-light border-b-2 border-decoricks-brown'
                  : 'text-decoricks-dark/60 hover:text-decoricks-dark hover:bg-decoricks-dark/5'
              }
            `}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div ref={contentRef} className="mt-4">
        {children(activeTab)}
      </div>
    </div>
  )
}
