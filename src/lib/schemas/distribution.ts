import { z } from 'zod'

/** 'YYYY-MM' Karachi month key, e.g. 2026-09. */
export const distributionMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month must be YYYY-MM')

export const distributionCreateSchema = z.object({
  month: distributionMonthSchema,
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
})

/**
 * A Founder-created profit-share adjustment (SPEC §3.1.14). The reason is
 * mandatory — an unexplained change to a partner's share is exactly what the
 * transparency requirement is about. `amount` is signed paisa: negative takes
 * from the partner (redistributed pro-rata to the others per settings),
 * positive grants a bonus funded from retained earnings.
 */
export const distributionAdjustmentSchema = z.object({
  partnerName: z.string().trim().min(1, 'Partner name is required').max(120),
  amount: z
    .number()
    .int('Amount must be whole paisa')
    .refine((value) => value !== 0, { message: 'Adjustment cannot be zero' }),
  reason: z.string().trim().min(3, 'A reason is required').max(500),
})
