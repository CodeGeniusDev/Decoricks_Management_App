import bcrypt from 'bcryptjs'
import { getEnv } from '@/lib/env'

/**
 * Password hashing per SPEC.md §10.1.4 Threat 9 ("bcrypt, cost factor 12") and
 * §10.2.4 Test 11 (the stored `passwordHash` must be a bcrypt hash, never
 * plaintext).
 *
 * `bcryptjs` is used rather than the native `bcrypt` binding because this app
 * targets Vercel serverless functions (SPEC §8.1), where native addons are not
 * reliably available. It produces and verifies standard `$2a$`/`$2b$` bcrypt
 * hashes, so it satisfies Test 11 exactly.
 */

export const PASSWORD_UPPER_BOUND = 72 // bcrypt silently truncates beyond this

export interface PasswordPolicyResult {
  valid: boolean
  errors: string[]
}

/**
 * SPEC §10.1.1 Threat 1: minimum 12 characters with complexity required.
 * SPEC §10.2.1 Test 1 asserts that "123456" and "password" are rejected.
 */
export const validatePasswordStrength = (password: unknown): PasswordPolicyResult => {
  const errors: string[] = []
  const { PASSWORD_MIN_LENGTH } = getEnv()

  if (typeof password !== 'string' || password.length === 0) {
    return { valid: false, errors: ['Password is required'] }
  }

  if (password.length < PASSWORD_MIN_LENGTH) {
    errors.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  }
  if (password.length > PASSWORD_UPPER_BOUND) {
    errors.push(`Password must be at most ${PASSWORD_UPPER_BOUND} characters`)
  }
  if (!/[a-z]/.test(password)) {
    errors.push('Password must include a lowercase letter')
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must include an uppercase letter')
  }
  if (!/[0-9]/.test(password)) {
    errors.push('Password must include a number')
  }

  return { valid: errors.length === 0, errors }
}

export const hashPassword = async (password: string): Promise<string> => {
  const { BCRYPT_COST } = getEnv()
  return bcrypt.hash(password, BCRYPT_COST)
}

export const verifyPassword = async (password: string, hash: string): Promise<boolean> => {
  if (!hash) return false
  try {
    return await bcrypt.compare(password, hash)
  } catch {
    // A malformed hash must read as "wrong password", never as a crash that
    // could be probed to distinguish states.
    return false
  }
}

/** Exposed for SPEC §10.2.4 Test 11 assertions. */
export const isBcryptHash = (value: string): boolean => /^\$2[aby]\$\d{2}\$/.test(value)