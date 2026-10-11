/**
 * Client-side view types for monthly profit distributions (Phase 4 brief
 * item 6). These mirror `serializeDistribution` in lib/distribution-service
 * exactly — keep both in sync when the API changes.
 */

import type { DistributionStatus } from '@/lib/models/Distribution'

export interface DistributionAdjustmentView {
  /** Signed paisa added to (+) or taken from (−) this partner's share. */
  amount: number
  reason: string
  adjustedBy: string
  adjustedByName?: string
  /** ISO timestamp. */
  adjustedAt: string
}

export interface DistributionPartnerShareView {
  partnerId?: string
  partnerName: string
  sharePercentage: number
  shareAmount: number
  reinvestPercentage: number
  reinvestedAmount: number
  adjustments: DistributionAdjustmentView[]
  finalAmount: number
  availableToWithdraw: number
}

export interface DistributionPolicyPartnerView {
  name: string
  percentage: number
  reinvestPercentage: number
  userId?: string
}

export interface DistributionView {
  _id?: string
  distributionNumber?: string
  /** ISO 'YYYY-MM' Karachi month. */
  month: string
  periodStart: string
  periodEnd: string
  totalRevenue: number
  refunds: number
  netSales: number
  cogs: number
  cogsProvisional: boolean
  grossProfit: number
  operatingExpenses: number
  netProfit: number
  partnerShares: DistributionPartnerShareView[]
  charityShare: { percentage: number; amount: number }
  reinvestmentAmount: number
  retainedEarnings: number
  status: DistributionStatus
  locked: boolean
  approvedByName?: string
  approvedAt?: string
  distributedAt?: string
  policySnapshot: { partners: DistributionPolicyPartnerView[]; charityPercentage: number }
  createdAt: string
  updatedAt: string
}

/** Status labels spelled out — a lock is a business fact, not a color. */
export const STATUS_LABEL: Record<DistributionStatus, string> = {
  calculated: 'Calculated — not approved',
  approved: 'Approved · locked',
  distributed: 'Distributed',
}

export const STATUS_BADGE: Record<DistributionStatus, 'warning' | 'success' | 'default'> = {
  calculated: 'warning',
  approved: 'success',
  distributed: 'default',
}

/**
 * 'YYYY-MM' → 'September 2026'. Deterministic: the month key is parsed as
 * UTC (no local-timezone drift) and formatted in UTC, so server and client
 * render the identical string.
 */
export function monthLabelKarachi(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  if (!match) return month
  const date = Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)
  return new Date(date).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}
