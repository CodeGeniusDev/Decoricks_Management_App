/**
 * Partner Investment Calculation Tests
 *
 * Verifies the partner investment summary calculation logic.
 */

import { describe, it, expect } from 'vitest'
import { computePartnerInvestment } from '@/lib/partner-investment'
import type { LedgerEntryLike } from '@/lib/finance'

const PAISA = (rupees: number) => Math.round(rupees * 100)

describe('Partner Investment Calculation', () => {
  it('correctly calculates partner capital and withdrawals', () => {
    const entries: LedgerEntryLike[] = [
      {
        type: 'partner_capital',
        amount: PAISA(10000),
        date: '2024-01-01',
        partnerName: 'Hasnat',
        partnerId: 'partner-1',
      },
      {
        type: 'partner_capital',
        amount: PAISA(5000),
        date: '2024-01-15',
        partnerName: 'Ali',
        partnerId: 'partner-2',
      },
      {
        type: 'partner_withdrawal',
        amount: PAISA(2000),
        date: '2024-01-20',
        partnerName: 'Hasnat',
        partnerId: 'partner-1',
      },
    ]

    const summary = computePartnerInvestment(entries, {
      start: new Date('2024-01-01'),
      end: new Date('2024-01-31'),
    })

    expect(summary.partners).toHaveLength(2)
    expect(summary.totalCapitalIn).toBe(PAISA(15000))
    expect(summary.totalWithdrawalsOut).toBe(PAISA(2000))
    expect(summary.totalNetBalance).toBe(PAISA(13000))

    const hasnat = summary.partners.find((p) => p.partnerName === 'Hasnat')
    expect(hasnat).toBeDefined()
    expect(hasnat?.capitalIn).toBe(PAISA(10000))
    expect(hasnat?.withdrawalsOut).toBe(PAISA(2000))
    expect(hasnat?.netBalance).toBe(PAISA(8000))
    expect(hasnat?.capitalTransactionCount).toBe(1)
    expect(hasnat?.withdrawalTransactionCount).toBe(1)

    const ali = summary.partners.find((p) => p.partnerName === 'Ali')
    expect(ali).toBeDefined()
    expect(ali?.capitalIn).toBe(PAISA(5000))
    expect(ali?.withdrawalsOut).toBe(0)
    expect(ali?.netBalance).toBe(PAISA(5000))
    expect(ali?.capitalTransactionCount).toBe(1)
    expect(ali?.withdrawalTransactionCount).toBe(0)
  })

  it('handles reversals correctly', () => {
    const entries: LedgerEntryLike[] = [
      {
        type: 'partner_capital',
        amount: PAISA(10000),
        date: '2024-01-01',
        partnerName: 'Hasnat',
        partnerId: 'partner-1',
      },
      {
        type: 'partner_capital',
        amount: PAISA(10000),
        date: '2024-01-02',
        partnerName: 'Hasnat',
        partnerId: 'partner-1',
        isReversal: true,
      },
    ]

    const summary = computePartnerInvestment(entries, {
      start: new Date('2024-01-01'),
      end: new Date('2024-01-31'),
    })

    expect(summary.totalCapitalIn).toBe(0)
    expect(summary.totalWithdrawalsOut).toBe(0)
    expect(summary.totalNetBalance).toBe(0)

    const hasnat = summary.partners.find((p) => p.partnerName === 'Hasnat')
    expect(hasnat?.capitalIn).toBe(0)
    expect(hasnat?.capitalTransactionCount).toBe(0)
  })

  it('filters by date range correctly', () => {
    const entries: LedgerEntryLike[] = [
      {
        type: 'partner_capital',
        amount: PAISA(10000),
        date: '2024-01-01',
        partnerName: 'Hasnat',
      },
      {
        type: 'partner_capital',
        amount: PAISA(5000),
        date: '2024-02-01',
        partnerName: 'Hasnat',
      },
    ]

    const summary = computePartnerInvestment(entries, {
      start: new Date('2024-01-01'),
      end: new Date('2024-01-31'),
    })

    expect(summary.totalCapitalIn).toBe(PAISA(10000))
    expect(summary.transactionCount).toBe(1)
  })

  it('handles partners without partnerId', () => {
    const entries: LedgerEntryLike[] = [
      {
        type: 'partner_capital',
        amount: PAISA(10000),
        date: '2024-01-01',
        partnerName: 'Hasnat',
      },
    ]

    const summary = computePartnerInvestment(entries, {
      start: new Date('2024-01-01'),
      end: new Date('2024-01-31'),
    })

    const hasnat = summary.partners.find((p) => p.partnerName === 'Hasnat')
    expect(hasnat).toBeDefined()
    expect(hasnat?.partnerId).toBeUndefined()
  })

  it('ignores non-partner transaction types', () => {
    const entries: LedgerEntryLike[] = [
      {
        type: 'income',
        amount: PAISA(10000),
        date: '2024-01-01',
      },
      {
        type: 'expense',
        amount: PAISA(5000),
        date: '2024-01-02',
      },
      {
        type: 'partner_capital',
        amount: PAISA(3000),
        date: '2024-01-03',
        partnerName: 'Hasnat',
      },
    ]

    const summary = computePartnerInvestment(entries, {
      start: new Date('2024-01-01'),
      end: new Date('2024-01-31'),
    })

    expect(summary.totalCapitalIn).toBe(PAISA(3000))
    expect(summary.transactionCount).toBe(1)
  })

  it('correctly calculates negative net balance', () => {
    const entries: LedgerEntryLike[] = [
      {
        type: 'partner_capital',
        amount: PAISA(5000),
        date: '2024-01-01',
        partnerName: 'Hasnat',
      },
      {
        type: 'partner_withdrawal',
        amount: PAISA(10000),
        date: '2024-01-02',
        partnerName: 'Hasnat',
      },
    ]

    const summary = computePartnerInvestment(entries, {
      start: new Date('2024-01-01'),
      end: new Date('2024-01-31'),
    })

    const hasnat = summary.partners.find((p) => p.partnerName === 'Hasnat')
    expect(hasnat?.netBalance).toBe(PAISA(-5000))
  })
})
