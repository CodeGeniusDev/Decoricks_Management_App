/**
 * Money utilities for handling PKR currency stored as integer paisa
 * 1 PKR = 100 paisa
 */

/**
 * Convert PKR to paisa
 * @param pkr - Amount in PKR (e.g., 150.50)
 * @returns Amount in paisa (e.g., 15050)
 */
export function pkrToPaisa(pkr: number): number {
  return Math.round(pkr * 100)
}

/**
 * Convert paisa to PKR
 * @param paisa - Amount in paisa (e.g., 15050)
 * @returns Amount in PKR (e.g., 150.50)
 */
export function paisaToPkr(paisa: number): number {
  return paisa / 100
}

/**
 * Format paisa as PKR string
 * @param paisa - Amount in paisa
 * @returns Formatted string (e.g., "PKR 150.50")
 */
export function formatPaisa(paisa: number): string {
  const pkr = paisaToPkr(paisa)
  return `PKR ${pkr.toFixed(2)}`
}

/**
 * Format PKR as string
 * @param pkr - Amount in PKR
 * @returns Formatted string (e.g., "PKR 150.50")
 */
export function formatPkr(pkr: number): string {
  return `PKR ${pkr.toFixed(2)}`
}

/**
 * Safe addition of paisa amounts
 * @param amounts - Array of paisa amounts
 * @returns Sum in paisa
 */
export function addPaisa(...amounts: number[]): number {
  return amounts.reduce((sum, amount) => sum + amount, 0)
}

/**
 * Safe subtraction of paisa amounts
 * @param minuend - Amount to subtract from
 * @param subtrahends - Amounts to subtract
 * @returns Difference in paisa
 */
export function subtractPaisa(minuend: number, ...subtrahends: number[]): number {
  const totalSubtrahend = subtrahends.reduce((sum, amount) => sum + amount, 0)
  return minuend - totalSubtrahend
}

/**
 * Safe multiplication of paisa amounts
 * @param paisa - Amount in paisa
 * @param multiplier - Multiplier
 * @returns Product in paisa
 */
export function multiplyPaisa(paisa: number, multiplier: number): number {
  return Math.round(paisa * multiplier)
}

/**
 * Safe division of paisa amounts
 * @param paisa - Amount in paisa
 * @param divisor - Divisor
 * @returns Quotient in paisa
 */
export function dividePaisa(paisa: number, divisor: number): number {
  if (divisor === 0) {
    throw new Error('Division by zero')
  }
  return Math.round(paisa / divisor)
}

/**
 * Validate paisa amount (must be non-negative integer)
 * @param paisa - Amount in paisa
 * @returns True if valid
 */
export function isValidPaisa(paisa: number): boolean {
  return Number.isInteger(paisa) && paisa >= 0
}

/**
 * Validate PKR amount (must be non-negative number)
 * @param pkr - Amount in PKR
 * @returns True if valid
 */
export function isValidPkr(pkr: number): boolean {
  return typeof pkr === 'number' && !isNaN(pkr) && pkr >= 0 && Number.isFinite(pkr)
}
