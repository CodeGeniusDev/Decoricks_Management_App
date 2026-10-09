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
