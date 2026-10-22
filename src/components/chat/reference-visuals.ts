import type { IconType } from '@/components/ui/icons'
import {
  IconBudgets,
  IconDistribution,
  IconFinance,
  IconFinanceAlt,
  IconInventory,
  IconReference,
  IconSales,
  IconSuppliers,
  IconTasks,
} from '@/components/ui/icons'

/**
 * Presentation for record-reference chips.
 *
 * The glyph and the short noun are derived from the entity TYPE, never from the
 * record itself: the label and any summary text come back from the server
 * already permission-checked, and this file exists only so a chip looks the same
 * in the picker, in the composer tray and in the transcript.
 *
 * The type list is intentionally a superset fallback rather than a second source
 * of truth — the picker renders the labels the server sends in `types`, so a
 * module added to the registry becomes searchable without editing this file.
 */

const ENTITY_ICONS: Record<string, IconType> = {
  order: IconSales,
  task: IconTasks,
  product: IconInventory,
  budget: IconBudgets,
  transaction: IconFinance,
  distribution: IconDistribution,
  account: IconFinanceAlt,
  supplier: IconSuppliers,
}

const ENTITY_NOUNS: Record<string, string> = {
  order: 'Order',
  task: 'Task',
  product: 'Product',
  budget: 'Budget',
  transaction: 'Entry',
  distribution: 'Distribution',
  account: 'Account',
  supplier: 'Supplier',
}

/** Unknown types must still render a chip — an honest generic one, not a blank. */
export const entityIcon = (entityType: string): IconType =>
  ENTITY_ICONS[entityType] ?? IconReference

export const entityNoun = (entityType: string): string => ENTITY_NOUNS[entityType] ?? 'Record'
