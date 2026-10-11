import { Collection, Db, ObjectId } from 'mongodb'
import type { ProfitSharePartner } from './Ledger'

/**
 * SPEC §3.1.13 profitDistributions — monthly, Founder-approved, lockable.
 *
 * A distribution is an immutable *snapshot* of the ledger-derived numbers at
 * calculation time: the P&L inputs, the policy that split them, and the
 * resulting per-partner breakdown. Recomputing is allowed while the record is
 * still `calculated`; approving locks it forever (adjustments afterwards are
 * new linked records, never edits), matching the ledger's no-silent-edits rule.
 */

export type DistributionStatus = 'calculated' | 'approved' | 'distributed'

export interface DistributionAdjustment {
  /** Signed paisa added to (+) or taken from (−) this partner's share. */
  amount: number
  reason: string
  adjustedBy: ObjectId
  adjustedByName?: string
  adjustedAt: Date
}

export interface DistributionPartnerShare {
  partnerId?: string
  partnerName: string
  /** Percent of net profit that produced `shareAmount` (snapshot, not live). */
  sharePercentage: number
  shareAmount: number // paisa
  /** Percent of the share retained in the business (SPEC §5.8 snapshot). */
  reinvestPercentage: number
  reinvestedAmount: number // paisa
  adjustments: DistributionAdjustment[]
  /** shareAmount − reinvestedAmount + adjustments, after redistribution. */
  finalAmount: number
  /** finalAmount − reinvestedAmount: what this partner may now withdraw. */
  availableToWithdraw: number
}

export interface ProfitDistribution {
  _id?: ObjectId
  distributionNumber?: string
  /** ISO 'YYYY-MM' Karachi month this distribution covers. */
  month: string
  periodStart: Date
  periodEnd: Date
  // ── P&L snapshot (paisa) ──────────────────────────────────────────────
  totalRevenue: number
  refunds: number
  netSales: number
  /** Provisional until Phase 5 inventory COGS lands. */
  cogs: number
  cogsProvisional: boolean
  grossProfit: number
  operatingExpenses: number
  netProfit: number
  // ── Split snapshot ────────────────────────────────────────────────────
  partnerShares: DistributionPartnerShare[]
  charityShare: { percentage: number; amount: number }
  reinvestmentAmount: number
  /** netProfit − charity − Σ partner final shares (paisa). */
  retainedEarnings: number
  status: DistributionStatus
  approvedBy?: ObjectId
  approvedByName?: string
  approvedAt?: Date
  distributedAt?: Date
  /** The exact policy this run used, for full transparency. */
  policySnapshot: { partners: ProfitSharePartner[]; charityPercentage: number }
  idempotencyKey?: string
  createdBy: ObjectId
  createdAt: Date
  updatedAt: Date
}

export const getProfitDistributionCollection = (db: Db): Collection<ProfitDistribution> =>
  db.collection<ProfitDistribution>('profitDistributions')

let distributionIndexPromise: Promise<void> | null = null

export function ensureDistributionIndexes(db: Db): Promise<void> {
  if (!distributionIndexPromise) {
    distributionIndexPromise = (async () => {
      try {
        await Promise.all([
          getProfitDistributionCollection(db).createIndex(
            { distributionNumber: 1 },
            { unique: true, sparse: true, name: 'distributionNumber_unique' }
          ),
          getProfitDistributionCollection(db).createIndex(
            { periodStart: 1, periodEnd: 1 },
            { unique: true, name: 'distribution_period_unique' }
          ),
          getProfitDistributionCollection(db).createIndex(
            { idempotencyKey: 1 },
            { unique: true, sparse: true, name: 'distribution_idempotency_unique' }
          ),
          getProfitDistributionCollection(db).createIndex({ status: 1 }, { name: 'distribution_status' }),
        ])
      } catch (error) {
        distributionIndexPromise = null
        console.error('Failed to ensure distribution indexes:', error)
      }
    })()
  }
  return distributionIndexPromise
}

/** A locked distribution accepts no writes at all. */
export const isDistributionLocked = (d: Pick<ProfitDistribution, 'status'>): boolean =>
  d.status === 'approved' || d.status === 'distributed'
