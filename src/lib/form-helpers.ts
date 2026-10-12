import { karachiCivil } from '@/lib/finance'
import { isValidPkr, paisaToPkr, pkrToPaisa } from '@/lib/money'

/**
 * Client form helpers shared by every write screen (Phase 3 ledger, Phase 5
 * inventory and sales).
 *
 * They live here rather than inside a module folder because the inventory and
 * sales forms need exactly the same money/date/idempotency behaviour as the
 * ledger forms: one parser for paisa, one clock for Karachi date inputs, one
 * key per form session, one shape for server field errors. Duplicating them per
 * module is how two screens end up rounding money differently.
 */

/** Today as `YYYY-MM-DD` on the Karachi civil calendar. */
export const karachiToday = (): string => {
  const { year, month, day } = karachiCivil(new Date())
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** ISO instant -> `YYYY-MM-DD` on the Karachi civil calendar (for date inputs). */
export const toKarachiInputDate = (iso: string): string => {
  const { year, month, day } = karachiCivil(new Date(iso))
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * A fresh idempotency key per form session. `crypto.randomUUID` exists in every
 * browser we target; the fallback keeps the form usable if it ever doesn't.
 */
export const newIdempotencyKey = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

/**
 * Parse a PKR amount typed by a human into integer paisa. Rejects anything
 * with more than two decimals so a float never sneaks into the ledger.
 */
export const parsePkrAmount = (
  raw: string
): { ok: true; paisa: number } | { ok: false; error: string } => {
  const trimmed = raw.trim().replace(/,/g, '')
  if (!trimmed) return { ok: false, error: 'Amount is required' }
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return { ok: false, error: 'Enter a positive amount with at most 2 decimals' }
  }
  const pkr = Number(trimmed)
  if (!Number.isFinite(pkr) || !isValidPkr(pkr)) {
    return { ok: false, error: 'Enter a valid amount' }
  }
  return { ok: true, paisa: pkrToPaisa(pkr) }
}

/** Like `parsePkrAmount`, but an empty field is allowed (optional amounts). */
export const parseOptionalPkrAmount = (
  raw: string
): { ok: true; paisa: null } | { ok: true; paisa: number } | { ok: false; error: string } => {
  if (!raw.trim()) return { ok: true, paisa: null }
  return parsePkrAmount(raw)
}

/** Paisa rendered into a text input the user can edit (no locale noise). */
export const paisaToInputValue = (paisa: number): string => paisaToPkr(paisa).toFixed(2)

/** A positive whole number of units, or a field error. */
export const parseQuantity = (
  raw: string
): { ok: true; value: number } | { ok: false; error: string } => {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, error: 'Quantity is required' }
  const value = Number(trimmed)
  if (!Number.isInteger(value) || value <= 0) {
    return { ok: false, error: 'Enter a whole number greater than zero' }
  }
  return { ok: true, value }
}

/**
 * A counted on-hand quantity: a whole number that may legitimately be zero
 * (an empty shelf is a finding, not a missing input). Used only by the
 * physical-count form; movements that *transfer* units still need
 * `parseQuantity`.
 */
export const parseCountedQuantity = (
  raw: string
): { ok: true; value: number } | { ok: false; error: string } => {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, error: 'Enter the quantity you counted' }
  const value = Number(trimmed)
  if (!Number.isInteger(value) || value < 0) {
    return { ok: false, error: 'Enter a whole number of units, 0 or more' }
  }
  return { ok: true, value }
}

/** Flatten the server's `details` array into `field -> message` for inputs. */
export const fieldIssues = (details: unknown): Record<string, string> => {
  const out: Record<string, string> = {}
  if (Array.isArray(details)) {
    for (const item of details) {
      if (item && typeof item === 'object' && 'path' in item && 'message' in item) {
        const entry = item as { path: string; message: string }
        if (typeof entry.path === 'string' && typeof entry.message === 'string') {
          out[entry.path] = entry.message
        }
      }
    }
  }
  return out
}
