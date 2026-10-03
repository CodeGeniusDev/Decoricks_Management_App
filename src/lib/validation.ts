import { z } from 'zod'

/**
 * Validate request body against a Zod schema
 * @param schema - Zod schema to validate against
 * @param data - Data to validate
 * @returns Validated data or throws error
 */
export function validateRequest<T>(schema: z.ZodSchema<T>, data: unknown): T {
  try {
    return schema.parse(data)
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errors = error.errors.map((err) => ({
        path: err.path.join('.'),
        message: err.message,
      }))
      throw new Error(`Validation failed: ${JSON.stringify(errors)}`)
    }
    throw error
  }
}

/**
 * Safely parse request body against a Zod schema
 * @param schema - Zod schema to validate against
 * @param data - Data to validate
 * @returns Object with success flag and data or error
 */
export function safeValidateRequest<T>(
  schema: z.ZodSchema<T>,
  data: unknown
): { success: true; data: T } | { success: false; error: z.ZodError } {
  const result = schema.safeParse(data)
  if (result.success) {
    return { success: true, data: result.data }
  }
  return { success: false, error: result.error }
}

/**
 * Format Zod error for API response
 * @param error - Zod error
 * @returns Formatted error object
 */
export function formatZodError(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.errors.map((err) => ({
    path: err.path.join('.'),
    message: err.message,
  }))
}

/**
 * Common validation schemas
 */
export const commonSchemas = {
  // MongoDB ObjectId
  objectId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid ObjectId'),

  // Email
  email: z.string().email('Invalid email address'),

  // URL
  url: z.string().url('Invalid URL'),

  // Date (ISO string)
  isoDate: z.string().datetime('Invalid date format'),

  // Positive integer
  positiveInteger: z.number().int().positive('Must be a positive integer'),

  // Non-negative integer
  nonNegativeInteger: z.number().int().nonnegative('Must be a non-negative integer'),

  // Money (paisa - stored as integer)
  paisa: z.number().int().nonnegative('Amount must be a non-negative integer (paisa)'),

  // Money (PKR - stored as number)
  pkr: z.number().nonnegative('Amount must be a non-negative number (PKR)'),

  // Phone number (Pakistan format)
  phone: z.string().regex(/^03[0-9]{9}$/, 'Invalid Pakistan phone number'),

  // Pagination
  pagination: z.object({
    page: z.number().int().positive().default(1),
    limit: z.number().int().positive().max(100).default(20),
  }),

  // Sort order
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
}
