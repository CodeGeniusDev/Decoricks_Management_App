import type React from 'react'
import {
  IconBudgets,
  IconChat,
  IconDashboard,
  IconFinance,
  IconInventory,
  IconSales,
  IconSettings,
  IconSuppliers,
  IconSummary,
  IconTasks,
} from '@/components/ui/icons'

export interface NavItem {
  name: string
  href: string
  icon: React.ReactNode
  /** Short label used by the mobile drawer footer / compact contexts. */
  shortName?: string
}

/**
 * Single source of truth for navigation.
 *
 * This list used to be duplicated across Sidebar, MobileNav and Header with no
 * icons at all — which is why the collapsed sidebar appeared to lose its icons:
 * there was never anything to render. Both the desktop sidebar and the mobile
 * drawer now read from here, so they cannot drift apart.
 *
 * The list stays complete regardless of role. `canAccessRoute` in
 * `src/lib/permissions-client.ts` filters it for display; hiding an item is a
 * convenience, not the enforcement (SPEC §4.3 requires that server-side).
 */
export const navItems: NavItem[] = [
  { name: 'Dashboard', href: '/', icon: <IconDashboard size={20} />, shortName: 'Home' },
  { name: 'Finance', href: '/finance', icon: <IconFinance size={20} /> },
  { name: 'Budgets', href: '/budgets', icon: <IconBudgets size={20} /> },
  { name: 'Inventory', href: '/inventory', icon: <IconInventory size={20} /> },
  { name: 'Sales', href: '/sales', icon: <IconSales size={20} /> },
  { name: 'Tasks', href: '/tasks', icon: <IconTasks size={20} /> },
  { name: 'Chat', href: '/chat', icon: <IconChat size={20} /> },
  { name: 'Suppliers', href: '/suppliers', icon: <IconSuppliers size={20} /> },
  { name: 'Weekly Summary', href: '/weekly-summary', icon: <IconSummary size={20} /> },
  { name: 'Settings', href: '/settings', icon: <IconSettings size={20} /> },
]

/**
 * Active-route matching.
 *
 * `/` must only match exactly — a naive `startsWith('/')` would light up the
 * Dashboard item on every route in the app.
 */
export function isActiveRoute(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(`${href}/`)
}