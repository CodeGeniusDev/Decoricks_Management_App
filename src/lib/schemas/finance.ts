import { z } from 'zod'

export const incomeSchema = z.object({
  amount: z.number().int().positive('Amount must be a positive integer (paisa)'),
  category: z.string().min(1, 'Category is required'),
  source: z.string().min(1, 'Source is required'),
  description: z.string().optional(),
  referenceId: z.string().optional(),
  referenceType: z.string().optional(),
  date: z.string().datetime('Invalid date format'),
})

export const expenseSchema = z.object({
  amount: z.number().int().positive('Amount must be a positive integer (paisa)'),
  category: z.string().min(1, 'Category is required'),
  vendorId: z.string().optional(),
  description: z.string().optional(),
  referenceId: z.string().optional(),
  referenceType: z.string().optional(),
  date: z.string().datetime('Invalid date format'),
})

export const transferSchema = z.object({
  fromAccount: z.string().min(1, 'From account is required'),
  toAccount: z.string().min(1, 'To account is required'),
  amount: z.number().int().positive('Amount must be a positive integer (paisa)'),
  description: z.string().optional(),
  date: z.string().datetime('Invalid date format'),
})

export const paginationQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 1))
    .refine((val) => val > 0, { message: 'Page must be positive' }),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 50))
    .refine((val) => val > 0 && val <= 100, { message: 'Limit must be between 1 and 100' }),
  category: z.string().optional(),
  startDate: z.string().datetime('Invalid start date').optional(),
  endDate: z.string().datetime('Invalid end date').optional(),
})

export type IncomeFormData = z.infer<typeof incomeSchema>
export type ExpenseFormData = z.infer<typeof expenseSchema>
export type TransferFormData = z.infer<typeof transferSchema>
export type PaginationQuery = z.infer<typeof paginationQuerySchema>

/* -------------------------------------------------------------------------- */
/* Phase 3 ledger                                                              */
/* -------------------------------------------------------------------------- */

const objectIdString = (label: string) =>
  z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/, `${label} must be a valid id`)

/**
 * Accepts either a full ISO instant or a `YYYY-MM-DD` Karachi date. The route
 * decides how to interpret a date-only value (Karachi midnight) so the client
 * can send either without the server guessing a timezone from a locale string.
 */
const ledgerDate = z
  .string()
  .min(1, 'Date is required')
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Invalid date format')
  .refine(
    (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) || /T/.test(value),
    'Use YYYY-MM-DD or an ISO datetime'
  )

const amountSchema = z
  .number({ invalid_type_error: 'Amount must be a number (paisa)' })
  .int('Amount must be a whole number of paisa')
  .positive('Amount must be greater than zero')

const noteSchema = z.string().max(1000, 'Note is too long').optional()
const paymentMethodSchema = z.string().max(60).optional()
const idempotencyKeySchema = z.string().min(8).max(128).optional()

const accountIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Select a valid account')
const optionalObjectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id').optional()

export const ledgerIncomeSchema = z.object({
  type: z.literal('income'),
  amount: amountSchema,
  date: ledgerDate,
  accountId: accountIdSchema,
  category: z.string().min(1, 'Category is required'),
  paymentMethod: paymentMethodSchema,
  note: noteSchema,
  idempotencyKey: idempotencyKeySchema,
})

export const ledgerExpenseSchema = z.object({
  type: z.literal('expense'),
  amount: amountSchema,
  date: ledgerDate,
  accountId: accountIdSchema,
  category: z.string().min(1, 'Category is required'),
  paymentMethod: paymentMethodSchema,
  note: noteSchema,
  idempotencyKey: idempotencyKeySchema,
})

export const ledgerTransferSchema = z.object({
  type: z.literal('transfer'),
  amount: amountSchema,
  date: ledgerDate,
  fromAccountId: accountIdSchema,
  toAccountId: accountIdSchema,
  note: noteSchema,
  idempotencyKey: idempotencyKeySchema,
})

export const ledgerPartnerCapitalSchema = z.object({
  type: z.literal('partner_capital'),
  amount: amountSchema,
  date: ledgerDate,
  accountId: accountIdSchema,
  partnerId: optionalObjectId,
  partnerName: z.string().max(120).optional(),
  paymentMethod: paymentMethodSchema,
  note: noteSchema,
  idempotencyKey: idempotencyKeySchema,
})

export const ledgerPartnerWithdrawalSchema = z.object({
  type: z.literal('partner_withdrawal'),
  amount: amountSchema,
  date: ledgerDate,
  accountId: accountIdSchema,
  partnerId: optionalObjectId,
  partnerName: z.string().max(120).optional(),
  paymentMethod: paymentMethodSchema,
  note: noteSchema,
  idempotencyKey: idempotencyKeySchema,
})

export const ledgerReinvestmentSchema = z.object({
  type: z.literal('reinvestment'),
  amount: amountSchema,
  date: ledgerDate,
  accountId: optionalObjectId,
  note: noteSchema,
  idempotencyKey: idempotencyKeySchema,
})

export const ledgerEntrySchema = z.discriminatedUnion('type', [
  ledgerIncomeSchema,
  ledgerExpenseSchema,
  ledgerTransferSchema,
  ledgerPartnerCapitalSchema,
  ledgerPartnerWithdrawalSchema,
  ledgerReinvestmentSchema,
])

export const reverseTransactionSchema = z.object({
  reason: z.string().max(500, 'Reason is too long').optional(),
  idempotencyKey: idempotencyKeySchema,
})

export const accountCreateSchema = z.object({
  name: z.string().min(1, 'Name is required').max(120),
  kind: z.enum(['cash', 'bank', 'wallet'], {
    errorMap: () => ({ message: 'Kind must be cash, bank or wallet' }),
  }),
  openingBalance: z
    .number({ invalid_type_error: 'Opening balance must be a number (paisa)' })
    .int('Opening balance must be a whole number of paisa')
    .default(0),
  note: z.string().max(500).optional(),
})

export const accountUpdateSchema = z.object({
  name: z.string().min(1, 'Name is required').max(120).optional(),
  kind: z.enum(['cash', 'bank', 'wallet']).optional(),
  openingBalance: z.number().int('Opening balance must be a whole number of paisa').optional(),
  isActive: z.boolean().optional(),
  note: z.string().max(500).optional(),
})

export const categoryCreateSchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    .max(60)
    .regex(/^[a-z0-9_]+$/, 'Use lowercase letters, numbers and underscores only'),
  label: z.string().min(1, 'Label is required').max(120),
  type: z.enum(['expense', 'income'], {
    errorMap: () => ({ message: 'Type must be expense or income' }),
  }),
})

export const categoryUpdateSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  isActive: z.boolean().optional(),
})

export const transactionQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .transform((value) => (value ? parseInt(value, 10) : 1))
    .refine((value) => Number.isFinite(value) && value > 0, { message: 'Page must be positive' }),
  limit: z
    .string()
    .optional()
    .transform((value) => (value ? parseInt(value, 10) : 25))
    .refine((value) => value > 0 && value <= 100, { message: 'Limit must be between 1 and 100' }),
  type: z.string().optional(),
  accountId: z.string().optional(),
  category: z.string().optional(),
  partnerId: z.string().optional(),
  search: z.string().max(120).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
})

export type LedgerEntryInput = z.infer<typeof ledgerEntrySchema>
export type AccountCreateInput = z.infer<typeof accountCreateSchema>
export type AccountUpdateInput = z.infer<typeof accountUpdateSchema>
export type CategoryCreateInput = z.infer<typeof categoryCreateSchema>
export type CategoryUpdateInput = z.infer<typeof categoryUpdateSchema>
export type TransactionQuery = z.infer<typeof transactionQuerySchema>
