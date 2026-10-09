import { describe, expect, it } from 'vitest'
import {
  hashPassword,
  isBcryptHash,
  validatePasswordStrength,
  verifyPassword,
} from '@/lib/auth/password'

/**
 * SPEC §10.2.1 Test 1 (weak passwords rejected) and §10.2.4 Test 11 (stored
 * value is a bcrypt hash, never plaintext).
 */

describe('validatePasswordStrength', () => {
  it('rejects the SPEC weak-password examples', () => {
    expect(validatePasswordStrength('123456').valid).toBe(false)
    expect(validatePasswordStrength('password').valid).toBe(false)
    expect(validatePasswordStrength('').valid).toBe(false)
    expect(validatePasswordStrength(undefined).valid).toBe(false)
  })

  it('enforces minimum length and character classes', () => {
    expect(validatePasswordStrength('short1A').valid).toBe(false)
    expect(validatePasswordStrength('alllowercase123').valid).toBe(false)
    expect(validatePasswordStrength('ALLUPPERCASE123').valid).toBe(false)
    expect(validatePasswordStrength('NoNumbersHereX').valid).toBe(false)
  })

  it('accepts a compliant password', () => {
    const result = validatePasswordStrength('Decoricks2026')
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('rejects a password beyond the bcrypt 72-byte limit', () => {
    expect(validatePasswordStrength(`Aa1${'x'.repeat(80)}`).valid).toBe(false)
  })
})

describe('hashPassword / verifyPassword', () => {
  it('stores a bcrypt hash at cost factor 12 and never the plaintext', async () => {
    const hash = await hashPassword('Decoricks2026')
    expect(hash).not.toContain('Decoricks2026')
    expect(isBcryptHash(hash)).toBe(true)
    expect(hash).toMatch(/^\$2[aby]\$12\$/)
  })

  it('verifies the correct password and rejects the wrong one', async () => {
    const hash = await hashPassword('Decoricks2026')
    await expect(verifyPassword('Decoricks2026', hash)).resolves.toBe(true)
    await expect(verifyPassword('Decoricks2027', hash)).resolves.toBe(false)
  })

  it('treats a missing or malformed hash as a failed comparison, not a crash', async () => {
    await expect(verifyPassword('anything', '')).resolves.toBe(false)
    await expect(verifyPassword('anything', 'not-a-hash')).resolves.toBe(false)
  })
})
