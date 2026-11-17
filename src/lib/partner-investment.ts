/**
 * Partner Investment Summary Engine
 *
 * Calculates per-partner capital contributions, withdrawals, and net balance
 * over a date range. Uses the same calculation logic as cash-flow.ts but
 * breaks down by partnerName instead of total.
 */

import type { LedgerEntryLike, DateRange } from '@/lib/finance'

export interface PartnerInvestmentLine {
  partnerName: string
  partnerId?: string
  /** Total capital contributed by this partner (paisa). */
  capitalIn: number
  /** Total withdrawals by this partner (paisa). */
  withdrawalsOut: number
  /** Net balance: capitalIn - withdrawalsOut (paisa). */
  netBalance: number
  /** Number of capital transactions. */
  capitalTransactionCount: number
  /** Number of withdrawal transactions. */
  withdrawalTransactionCount: number
}

export interface PartnerInvestmentSummary {
  /** Per-partner investment lines. */
  partners: PartnerInvestmentLine[]
  /** Total capital across all partners. */
  totalCapitalIn: number
  /** Total withdrawals across all partners. */
  totalWithdrawalsOut: number
  /** Total net balance across all partners. */
  totalNetBalance: number
  /** Range of the calculation. */
  range: DateRange
  /** Total number of transactions included. */
  transactionCount: number
}

/**
 * Compute partner investment summary for a date range.
 * Only includes partner_capital and partner_withdrawal entry types.
 * Reversals are handled correctly (they negate the effect).
 */
export function computePartnerInvestment(
  entries: LedgerEntryLike[],
  range: DateRange
): PartnerInvestmentSummary {
  const partnerMap = new Map<string, PartnerInvestmentLine>()
  let totalCapitalIn = 0
  let totalWithdrawalsOut = 0
  let transactionCount = 0

  for (const entry of entries) {
    // Skip if not a partner-related transaction type
    if (entry.type !== 'partner_capital' && entry.type !== 'partner_withdrawal') continue

    // Skip if not in date range
    const date = new Date(entry.date)
    if (date.getTime() < range.start.getTime() || date.getTime() > range.end.getTime()) continue

    transactionCount++

    const partnerName = entry.partnerName || 'Unknown'
    const partnerId = entry.partnerId

    // Get or create partner line
    let line = partnerMap.get(partnerName)
    if (!line) {
      line = {
        partnerName,
        partnerId,
        capitalIn: 0,
        withdrawalsOut: 0,
        netBalance: 0,
        capitalTransactionCount: 0,
        withdrawalTransactionCount: 0,
      }
      partnerMap.set(partnerName, line)
    }

    // Reversals negate the effect
    const sign = entry.isReversal ? -1 : 1
    const amount = sign * entry.amount

    if (entry.type === 'partner_capital') {
      line.capitalIn += amount
      line.capitalTransactionCount += sign
      totalCapitalIn += amount
    } else if (entry.type === 'partner_withdrawal') {
      line.withdrawalsOut += amount
      line.withdrawalTransactionCount += sign
      totalWithdrawalsOut += amount
    }

    // Update net balance
    line.netBalance = line.capitalIn - line.withdrawalsOut
  }

  // Convert map to array and update totals
  const partners = Array.from(partnerMap.values()).sort((a, b) =>
    a.partnerName.localeCompare(b.partnerName)
  )

  const totalNetBalance = totalCapitalIn - totalWithdrawalsOut

  return {
    partners,
    totalCapitalIn,
    totalWithdrawalsOut,
    totalNetBalance,
    range,
    transactionCount,
  }
}
