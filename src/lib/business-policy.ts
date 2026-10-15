import type { BudgetThresholds, BusinessSettings, ProfitSharePartner } from '@/lib/models/Ledger'

/**
 * The Phase 4 profit-sharing and budget-warning policy.
 *
 * Nothing in the engines reads hard-coded percentages: they read the
 * `businessSettings` singleton through `resolveBusinessPolicy` below. The
 * fallbacks match SPEC Appendix A exactly and only apply while the Founder has
 * configured nothing; `configured` tells the UI to say so loudly rather than
 * let seeded defaults masquerade as business decisions.
 */

/** SPEC Appendix A defaults — used by the seed and as the unconfigured fallback. */
export const SPEC_DEFAULT_CHARITY_PERCENTAGE = 20
export const SPEC_DEFAULT_PARTNER_PERCENTAGE = 20
export const SPEC_DEFAULT_BUDGET_THRESHOLDS: BudgetThresholds = { warning: 80, critical: 100 }

/**
 * Phase 8 (METRICS.md §A.7): the unconfigured advertising/marketing category set
 * used to split advertising spend out of operating expenses. These mirror the
 * SPEC Appendix A / seed marketing slugs; the Founder can override them on the
 * business settings. They are configuration, not invented business data.
 */
export const SPEC_DEFAULT_ADVERTISING_CATEGORIES: string[] = [
  'meta_ads',
  'flyers_printing',
  'content_production',
]

/** Partners listed in Appendix A; only names, never invented money. */
export const SPEC_DEFAULT_PARTNERS: Pick<ProfitSharePartner, 'name'>[] = [
  { name: 'Abdullah' },
  { name: 'Hasnat' },
  { name: 'Ali' },
  { name: 'Afnan' },
]

export interface ResolvedPolicy {
  partners: ProfitSharePartner[]
  charityPercentage: number
  budgetThresholds: BudgetThresholds
  /** Category slugs the dashboard treats as advertising spend (METRICS §A.7). */
  advertisingCategories: string[]
  /** True once the Founder (or the seed) has written a real configuration. */
  configured: boolean
}

export function resolveBusinessPolicy(
  settings: BusinessSettings | null | undefined
): ResolvedPolicy {
  const advertisingCategories =
    settings?.advertisingCategories ?? SPEC_DEFAULT_ADVERTISING_CATEGORIES
  const sharing = settings?.profitSharing
  if (!sharing || sharing.partners.length === 0) {
    return {
      partners: SPEC_DEFAULT_PARTNERS.map((p) => ({
        name: p.name,
        percentage: SPEC_DEFAULT_PARTNER_PERCENTAGE,
        reinvestPercentage: 0,
      })),
      charityPercentage: SPEC_DEFAULT_CHARITY_PERCENTAGE,
      budgetThresholds: SPEC_DEFAULT_BUDGET_THRESHOLDS,
      advertisingCategories,
      configured: false,
    }
  }

  return {
    partners: sharing.partners,
    charityPercentage: sharing.charityPercentage,
    budgetThresholds: settings?.budgetThresholds ?? SPEC_DEFAULT_BUDGET_THRESHOLDS,
    advertisingCategories,
    configured: true,
  }
}

/**
 * Server-side validation of a proposed profit-sharing configuration.
 * SPEC §3.2: partner percentages must sum to at most 100. Percentages are
 * whole numbers so paisa splits stay reproducible.
 */
export function validateProfitSharing(input: {
  partners: ProfitSharePartner[]
  charityPercentage: number
}): string[] {
  const issues: string[] = []

  if (input.partners.length === 0) {
    issues.push('At least one profit-sharing partner is required')
  }

  const names = new Set<string>()
  input.partners.forEach((partner, index) => {
    const where = `partners[${index}]`
    if (!partner.name?.trim()) issues.push(`${where}: name is required`)
    const key = partner.name?.trim().toLowerCase()
    if (names.has(key)) issues.push(`${where}: duplicate partner "${partner.name}"`)
    names.add(key)
    if (
      !Number.isInteger(partner.percentage) ||
      partner.percentage < 0 ||
      partner.percentage > 100
    ) {
      issues.push(`${where}: profit percentage must be a whole number between 0 and 100`)
    }
    if (
      !Number.isInteger(partner.reinvestPercentage) ||
      partner.reinvestPercentage < 0 ||
      partner.reinvestPercentage > 100
    ) {
      issues.push(`${where}: reinvestment percentage must be a whole number between 0 and 100`)
    }
  })

  const partnerTotal = input.partners.reduce((sum, p) => sum + (p.percentage || 0), 0)
  if (partnerTotal > 100) {
    issues.push(`Partner percentages sum to ${partnerTotal}%; they must sum to at most 100%`)
  }

  if (
    !Number.isInteger(input.charityPercentage) ||
    input.charityPercentage < 0 ||
    input.charityPercentage > 100
  ) {
    issues.push('Charity percentage must be a whole number between 0 and 100')
  } else if (partnerTotal + input.charityPercentage > 100) {
    issues.push(
      `Partners (${partnerTotal}%) plus charity (${input.charityPercentage}%) exceed 100% of net profit`
    )
  }

  return issues
}

/**
 * Phase 6: how long after posting a comment's author may still edit or
 * soft-delete it. Founder-editable; unconfigured falls back to 15 minutes
 * (brief default). The API layer reads the resolved value, never the raw
 * settings document, so a partial write cannot leave a comment un-editable
 * forever or open forever.
 */
export const DEFAULT_COMMENT_EDIT_WINDOW_MINUTES = 15

export function resolveCommentEditWindow(settings: BusinessSettings | null | undefined): number {
  const raw = settings?.commentEditWindowMinutes
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    return DEFAULT_COMMENT_EDIT_WINDOW_MINUTES
  }
  return raw
}

/** Convenience: is `attemptedAt` still within the edit window of `createdAt`? */
export function commentWithinEditWindow(
  createdAt: Date,
  attemptedAt: Date,
  windowMinutes: number
): boolean {
  // windowMinutes === 0 means the author can *never* edit/delete after the
  // initial POST; anything positive is a normal window. Negative numbers are
  // rejected above so `attemptedAt - createdAt <= 0` only fires on clocks
  // going backwards within the same request, which is not an edit window.
  const ms = attemptedAt.getTime() - createdAt.getTime()
  return ms <= windowMinutes * 60_000
}
