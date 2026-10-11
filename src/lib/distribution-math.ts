import type { ProfitSharePartner } from '@/lib/models/Ledger'

/**
 * Profit-distribution math (SPEC §5.8, §5.9, §3.1.13).
 *
 * Everything is integer paisa. Three rules make the arithmetic verify exactly:
 *
 *  1. **Largest-remainder splits.** A percentage split never loses or creates
 *     paisa: floors are taken first and the leftover unit paisa go to the
 *     largest fractional remainders (index order breaks ties). The parts always
 *     sum to the whole.
 *  2. **Per-partner reinvestment floors down** — §5.8's partner at 50% of
 *     826.67 reinvests 413.33 and keeps 413.34 withdrawable. Nothing is lost;
 *     the remainder simply stays on the partner's side of the split. The
 *     reported total reinvestment is the sum of the parts (2,066.67).
 *  3. **Zero-sum adjustments.** A deduction from one partner is redistributed
 *     pro-rata (by configured percentage) to the other partners, so the sum of
 *     final shares only moves by exactly what was redistributed. A bonus is a
 *     gift funded from retained earnings — it does not tax the other partners.
 *
 * The §5.8 worked example is reproduced exactly: net profit 4,133.36 splits
 * into five 826.67 buckets (plus the one leftover paisa by largest
 * remainder), and total reinvestment lands on 2,066.67.
 */

export interface SplitPart {
  key: string
  weight: number
}

/**
 * Allocate the FULL `totalPaisa` across relative weights with largest
 * remainder — no percentage scaling. Used where the total must move exactly
 * (e.g. redistributing a deduction to the other partners): the parts always
 * sum to `totalPaisa`, so nothing leaks into retained earnings.
 */
export function allocateExactly(totalPaisa: number, weights: number[]): number[] {
  const clean = weights.map((weight) =>
    Number.isFinite(weight) && weight > 0 ? weight : 0
  )
  const weightSum = clean.reduce((sum, weight) => sum + weight, 0)
  if (weightSum <= 0) return clean.map(() => 0)

  return distributePool(totalPaisa, clean, weightSum)
}

/**
 * Split `totalPaisa` across parts proportionally to their weights. Weights are
 * percentages of the whole; when they sum below 100 the unallocated residual
 * stays with the caller (retained earnings). Parts always sum exactly to the
 * allocated pool, and the pool is derived from `totalPaisa` without rounding
 * error when the weights sum to 100.
 */
export function largestRemainderSplit(totalPaisa: number, parts: SplitPart[]): number[] {
  const clean = parts.map((part) => ({
    ...part,
    weight: Number.isFinite(part.weight) && part.weight > 0 ? part.weight : 0,
  }))
  const weightSum = clean.reduce((sum, part) => sum + part.weight, 0)
  if (weightSum <= 0) return clean.map(() => 0)

  // The allocated pool: weights are percentages, so weights summing below 100
  // intentionally leave the remainder with the caller (retained earnings).
  const pool = Math.round((totalPaisa * Math.min(weightSum, 100)) / 100)

  return distributePool(pool, clean.map((part) => part.weight), weightSum)
}

/** Shared largest-remainder core: split `pool` across relative weights exactly. */
function distributePool(pool: number, weights: number[], weightSum: number): number[] {
  const raw = weights.map((weight) => (pool * weight) / weightSum)
  const floors = raw.map(Math.floor)
  let leftover = pool - floors.reduce((sum, value) => sum + value, 0)

  const order = raw
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)

  for (const { index } of order) {
    if (leftover <= 0) break
    floors[index] += 1
    leftover -= 1
  }
  return floors
}

export interface DistributionAdjustmentInput {
  /** `partnerKey` of the partner this adjustment applies to. */
  partnerKey: string
  /** Signed paisa. Negative = deduction (redistributed), positive = bonus. */
  amount: number
  reason: string
}

export interface DistributionPartnerResult {
  key: string
  partner: ProfitSharePartner
  shareAmount: number
  reinvestedAmount: number
  adjustmentsTotal: number
  finalAmount: number
  availableToWithdraw: number
}

export interface DistributionResult {
  netProfit: number
  charityPercentage: number
  charityAmount: number
  partners: DistributionPartnerResult[]
  totalReinvested: number
  totalFinalShares: number
  /** netProfit − charity − Σ final shares (paisa). */
  retainedEarnings: number
}

/** Stable public key for a partner within one distribution run. */
export function partnerKey(partner: ProfitSharePartner, index: number): string {
  return partner.userId ?? `partner-${index}-${partner.name.toLowerCase().replace(/\s+/g, '-')}`
}

/**
 * Full monthly split. Partner percentages are of net profit; charity takes
 * `charityPercentage` of net profit. Adjustments are applied in order, with
 * deductions redistributed pro-rata to the other partners (charity is fixed).
 */
export function computeDistribution(input: {
  netProfit: number
  partners: ProfitSharePartner[]
  charityPercentage: number
  adjustments?: DistributionAdjustmentInput[]
}): DistributionResult {
  const { netProfit, partners } = input
  const charityPercentage = input.charityPercentage

  // 1. Charity + partner shares from net profit, in one weighted split so the
  //    leftover paisa are allocated deterministically.
  const parts: SplitPart[] = [
    { key: '__charity__', weight: charityPercentage },
    ...partners.map((partner, index) => ({
      key: partnerKey(partner, index),
      weight: partner.percentage,
    })),
  ]
  const split = largestRemainderSplit(netProfit, parts)
  const charityAmount = split[0]
  const shareAmounts = split.slice(1)

  // 2. Reinvestment per partner: floor(share × reinvest%) (§5.8). The paisa
  //    below the floor stay on the partner's withdrawable side — nothing lost.
  const reinvestedAmounts = shareAmounts.map(
    (share, index) => Math.floor((share * partners[index].reinvestPercentage) / 100)
  )

  // 3. Base finals, then adjustments with pro-rata redistribution.
  const finals = [...shareAmounts]
  const adjustmentsTotal = partners.map(() => 0)

  for (const adjustment of input.adjustments ?? []) {
    const index = partners.findIndex((partner, i) => partnerKey(partner, i) === adjustment.partnerKey)
    if (index === -1 || adjustment.amount === 0) continue

    finals[index] += adjustment.amount
    adjustmentsTotal[index] += adjustment.amount

    if (adjustment.amount < 0) {
      // Deduction: give |amount| back to the other partners pro-rata. This is
      // a zero-sum reallocation, so it uses allocateExactly (weights are
      // relative here — scaling them as percentages of the whole would leak
      // paisa into retained earnings).
      const deducted = -adjustment.amount
      const others = partners
        .map((partner, i) => ({ key: partnerKey(partner, i), weight: partner.percentage, index: i }))
        .filter((part) => part.index !== index)
      const shares = allocateExactly(
        deducted,
        others.map((part) => part.weight)
      )
      others.forEach((part, position) => {
        finals[part.index] += shares[position]
        adjustmentsTotal[part.index] += shares[position]
      })
    }
    // Positive adjustments are bonuses funded from retained earnings; the
    // retained figure below absorbs them so the grand total still adds up.
  }

  const totalFinalShares = finals.reduce((sum, value) => sum + value, 0)

  const partnerResults: DistributionPartnerResult[] = partners.map((partner, index) => ({
    key: partnerKey(partner, index),
    partner,
    shareAmount: shareAmounts[index],
    reinvestedAmount: reinvestedAmounts[index],
    adjustmentsTotal: adjustmentsTotal[index],
    finalAmount: finals[index],
    availableToWithdraw: finals[index] - reinvestedAmounts[index],
  }))

  return {
    netProfit,
    charityPercentage,
    charityAmount,
    partners: partnerResults,
    totalReinvested: reinvestedAmounts.reduce((sum, value) => sum + value, 0),
    totalFinalShares,
    retainedEarnings: netProfit - charityAmount - totalFinalShares,
  }
}
