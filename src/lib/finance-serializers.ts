import { ACCOUNT_KIND_LABELS } from '@/lib/finance'
import { formatPaisa } from '@/lib/money'
import type { Account, FinanceCategory } from '@/lib/models/Ledger'

export interface SerializedAccount {
  _id: string
  name: string
  kind: Account['kind']
  kindLabel: string
  openingBalance: number
  openingBalanceDisplay: string
  balance: number
  balanceDisplay: string
  isActive: boolean
  note?: string
}

export const serializeAccount = (account: Account, balance: number): SerializedAccount => ({
  _id: account._id!.toString(),
  name: account.name,
  kind: account.kind,
  kindLabel: ACCOUNT_KIND_LABELS[account.kind],
  openingBalance: account.openingBalance,
  openingBalanceDisplay: formatPaisa(account.openingBalance),
  balance,
  balanceDisplay: formatPaisa(balance),
  isActive: account.isActive,
  note: account.note,
})

export const serializeCategory = (category: FinanceCategory) => ({
  _id: category._id!.toString(),
  name: category.name,
  label: category.label,
  type: category.type,
  isActive: category.isActive,
  createdAt: category.createdAt,
})
