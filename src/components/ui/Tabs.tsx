'use client'

import React, { useId, useRef, useState } from 'react'

interface TabsProps {
  tabs: Array<{ id: string; label: string }>
  defaultTab?: string
  children: (activeTab: string) => React.ReactNode
}

/**
 * Tabs — switchable panels.
 *
 * The fade animation that ran on every tab change meant clicking a tab re-rendered
 * the whole panel from transparent, so a user who tapped "Orders" and then
 * "Products" saw each panel pulse instead of simply swapping. Tabs now switch
 * instantly, and the container no longer animates on mount.
 *
 * ARIA is completed here too: `tablist` / `tab` / `tabpanel` with
 * `aria-controls` + `aria-labelledby` linking, and arrow-key navigation, which is
 * what a screen-reader user expects from a tab strip.
 */
export const Tabs = ({ tabs, defaultTab, children }: TabsProps) => {
  const [activeTab, setActiveTab] = useState(defaultTab || tabs[0]?.id)
  const baseId = useId()
  const listRef = useRef<HTMLDivElement>(null)

  const focusTab = (index: number) => {
    const clamped = (index + tabs.length) % tabs.length
    const next = tabs[clamped]
    if (!next) return
    setActiveTab(next.id)
    const button = listRef.current?.querySelector<HTMLButtonElement>(`#${CSS.escape(`${baseId}-tab-${next.id}`)}`)
    button?.focus()
  }

  const handleKeyDown = (event: React.KeyboardEvent, index: number) => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault()
        focusTab(index + 1)
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault()
        focusTab(index - 1)
        break
      case 'Home':
        event.preventDefault()
        focusTab(0)
        break
      case 'End':
        event.preventDefault()
        focusTab(tabs.length - 1)
        break
    }
  }

  return (
    <div>
      <div
        ref={listRef}
        role="tablist"
        aria-label="Sections"
        className="-mb-px flex gap-1 overflow-x-auto border-b border-line-subtle"
      >
        {tabs.map((tab, index) => {
          const isActive = activeTab === tab.id
          return (
            <button
              key={tab.id}
              id={`${baseId}-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`${baseId}-panel-${tab.id}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={`h-10 shrink-0 whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-decoricks-brown ${
                isActive
                  ? 'border-decoricks-brown text-decoricks-dark'
                  : 'border-transparent text-ink-muted hover:border-line-strong hover:text-ink-secondary'
              }`}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      {tabs.map((tab) => (
        <div
          key={tab.id}
          id={`${baseId}-panel-${tab.id}`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${tab.id}`}
          hidden={activeTab !== tab.id}
          tabIndex={0}
          className="pt-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-decoricks-brown"
        >
          {activeTab === tab.id && children(tab.id)}
        </div>
      ))}
    </div>
  )
}