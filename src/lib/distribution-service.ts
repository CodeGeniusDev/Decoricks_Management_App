import { Db, ObjectId } from 'mongodb'
import { getBusinessSettingsCollection, getLedgerCollection } from '@/lib/models/Ledger'
import {
  DistributionPartnerShare,
  ProfitDistribution,
  isDistributionLocked,
} from '@/lib/models/Distribution'
import { normalizeEntry } from '@/lib/finance-ledger'
import { karachiCivil, karachiMidnight, type DateRange, type LedgerEntryLike } from '@/lib/finance'
import { computeProfitLoss } from '@/lib/profit-loss'
import { computeDistribution, partnerKey } from '@/lib/distribution-math'
import { resolveBusinessPolicy } from '@/lib/business-policy'

/**
 * Server-side distribution assembly (SPEC §3.1.13, §5.8–§5.9).
 *
 * The math lives in the pure `distribution-math` engine; this module only
 * gathers ledger truth for a Karachi month, applies the configured policy,
 * and shapes the snapshot document. Recalculation with adjustments always
 * re-runs the full split from the stored P&L snapshot and the stored policy
 * snapshot, so a locked record's numbers can be re-derived by anyone, ever.
 */

/** Parse 'YYYY-MM' into the inclusive Karachi month range. */
export function karachiMonthRangeForMonth(month: string): DateRange | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month)
  if (!match) return null
  const year = Number(match[1])
  const m = Number(match[2])
  const start = karachiMidnight(year, m, 1)
  const next = karachiMidnight(m === 12 ? year + 1 : year, m === 12 ? 1 : m + 1, 1)
  return { start, end: new Date(next.getTime() - 1) }
}

/** 'YYYY-MM' key of a date in Karachi civil time. */
export function karachiMonthKey(date: Date): string {
  const civil = karachiCivil(date)
  return `${civil.year}-${String(civil.month).padStart(2, '0')}`
}

export async function fetchLedgerRange(db: Db, range: DateRange): Promise<LedgerEntryLike[]> {
  const docs = await getLedgerCollection(db)
    .find({ date: { $gte: range.start, $lte: range.end } })
    .toArray()
  return docs.map(normalizeEntry)
}

export interface FreshDistribution {
  month: string
  periodStart: Date
  periodEnd: Date
  totalRevenue: number
  refunds: number
  netSales: number
  cogs: number
  cogsProvisional: boolean
  grossProfit: number
  operatingExpenses: number
  netProfit: number
  partnerShares: DistributionPartnerShare[]
  charityShare: { percentage: number; amount: number }
  reinvestmentAmount: number
  retainedEarnings: number
  policySnapshot: { partners: ProfitDistribution['policySnapshot']['partners']; charityPercentage: number }
  entryCount: number
}

/** Compute a month's distribution from the live ledger and configured policy. */
export async function buildDistribution(db: Db, month: string): Promise<FreshDistribution | null> {
  const range = karachiMonthRangeForMonth(month)
  if (!range) return null

  const [entries, settings] = await Promise.all([
    fetchLedgerRange(db, range),
    getBusinessSettingsCollection(db).findOne({ key: 'business' }),
  ])

  const pl = computeProfitLoss(entries)
  const policy = resolveBusinessPolicy(settings)
  const result = computeDistribution({
    netProfit: pl.netProfit,
    partners: policy.partners,
    charityPercentage: policy.charityPercentage,
  })

  const shares: DistributionPartnerShare[] = result.partners.map((partner, index) => ({
    partnerId: partner.partner.userId,
    partnerName: partner.partner.name,
    sharePercentage: policy.partners[index].percentage,
    shareAmount: partner.shareAmount,
    reinvestPercentage: partner.partner.reinvestPercentage,
    reinvestedAmount: partner.reinvestedAmount,
    adjustments: [],
    finalAmount: partner.finalAmount,
    availableToWithdraw: partner.availableToWithdraw,
  }))

  return {
    month,
    periodStart: range.start,
    periodEnd: range.end,
    totalRevenue: pl.revenue,
    refunds: pl.refunds,
    netSales: pl.netSales,
    cogs: pl.cogs,
    cogsProvisional: pl.cogsProvisional,
    grossProfit: pl.grossProfit,
    operatingExpenses: pl.operatingExpenses,
    netProfit: pl.netProfit,
    partnerShares: shares,
    charityShare: { percentage: policy.charityPercentage, amount: result.charityAmount },
    reinvestmentAmount: result.totalReinvested,
    retainedEarnings: result.retainedEarnings,
    policySnapshot: { partners: policy.partners, charityPercentage: policy.charityPercentage },
    entryCount: pl.count,
  }
}

/** Flatten the stored adjustments back into engine inputs, in snapshot order. */
export function storedAdjustments(doc: ProfitDistribution) {
  const out: { partnerKey: string; amount: number; reason: string }[] = []
  doc.partnerShares.forEach((share, index) => {
    const partner = doc.policySnapshot.partners[index]
    if (!partner) return
    const key = partnerKey(partner, index)
    for (const adjustment of share.adjustments) {
      out.push({ partnerKey: key, amount: adjustment.amount, reason: adjustment.reason })
    }
  })
  return out
}

/**
 * Re-run the split for a stored document after adding an adjustment. Always
 * recomputed from the P&L snapshot + policy snapshot + all adjustment records,
 * never patched arithmetic-first — so the paisa add up by construction.
 */
export function recomputeShares(doc: ProfitDistribution): DistributionPartnerShare[] {
  const result = computeDistribution({
    netProfit: doc.netProfit,
    partners: doc.policySnapshot.partners,
    charityPercentage: doc.policySnapshot.charityPercentage,
    adjustments: storedAdjustments(doc),
  })

  return doc.partnerShares.map((share, index) => {
    const computed = result.partners[index]
    return {
      ...share,
      shareAmount: computed.shareAmount,
      reinvestedAmount: computed.reinvestedAmount,
      finalAmount: computed.finalAmount,
      availableToWithdraw: computed.availableToWithdraw,
    }
  })
}

export const serializeDistribution = (doc: ProfitDistribution) => ({
  _id: doc._id?.toString(),
  distributionNumber: doc.distributionNumber,
  month: doc.month,
  periodStart: doc.periodStart.toISOString(),
  periodEnd: doc.periodEnd.toISOString(),
  totalRevenue: doc.totalRevenue,
  refunds: doc.refunds,
  netSales: doc.netSales,
  cogs: doc.cogs,
  cogsProvisional: doc.cogsProvisional,
  grossProfit: doc.grossProfit,
  operatingExpenses: doc.operatingExpenses,
  netProfit: doc.netProfit,
  partnerShares: doc.partnerShares.map((share) => ({
    ...share,
    partnerId: share.partnerId,
    adjustments: share.adjustments.map((a) => ({
      ...a,
      adjustedBy: a.adjustedBy.toString(),
      adjustedAt: a.adjustedAt.toISOString(),
    })),
  })),
  charityShare: doc.charityShare,
  reinvestmentAmount: doc.reinvestmentAmount,
  retainedEarnings: doc.retainedEarnings,
  status: doc.status,
  locked: isDistributionLocked(doc),
  approvedBy: doc.approvedBy?.toString(),
  approvedByName: doc.approvedByName,
  approvedAt: doc.approvedAt?.toISOString(),
  distributedAt: doc.distributedAt?.toISOString(),
  policySnapshot: doc.policySnapshot,
  createdAt: doc.createdAt.toISOString(),
  updatedAt: doc.updatedAt.toISOString(),
})

/** `DIST-YYYYMM` — month-unique; the caller handles the duplicate retry. */
export const distributionNumberFor = (month: string): string => `DIST-${month.replace('-', '')}`

export const asObjectId = (id: string): ObjectId => new ObjectId(id)
