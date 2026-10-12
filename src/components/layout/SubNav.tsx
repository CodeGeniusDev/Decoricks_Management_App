'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

export interface SubNavItem {
  href: string
  label: string
}

/**
 * SubNav — the section strip under a page header for grouped screens.
 *
 * Sidebar stays flat (one entry per module) and these strips carry the section's
 * own screens, which is how SPEC §2.1's nested navigation is reachable without
 * inventing a collapsible tree for a 13-item sidebar. Links, not tab state: each
 * screen has its own URL, so a filter or a saved link survives a reload and
 * browser back works.
 *
 * The container scrolls horizontally only if the labels genuinely cannot fit;
 * at every breakpoint we support they wrap instead, so the page itself never
 * gains a horizontal scrollbar.
 */
export const SubNav = ({ items, className = '' }: { items: SubNavItem[]; className?: string }) => {
  const pathname = usePathname()

  return (
    <nav aria-label="Section" className={`mb-4 -mx-1 flex flex-wrap gap-1 px-1 ${className}`}>
      {items.map((item) => {
        const active =
          item.href === pathname ||
          (item.href.split('/').length >= 2 && pathname.startsWith(`${item.href}/`))
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`inline-flex h-11 min-w-[44px] items-center justify-center rounded-md px-3.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown md:h-9 ${
              active
                ? 'bg-decoricks-brown text-decoricks-light'
                : 'text-ink-secondary hover:bg-surface-sunken hover:text-ink'
            }`}
          >
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
