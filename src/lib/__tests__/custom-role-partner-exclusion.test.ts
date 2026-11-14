import { describe, it, expect } from 'vitest'
import { isPartnerRole, ROLE_FOUNDER, ROLE_HASNAT, ROLE_ALI, ROLE_AFNAN } from '@/lib/roles'

describe('isPartnerRole', () => {
  it('returns true for original partner roles', () => {
    expect(isPartnerRole(ROLE_HASNAT)).toBe(true)
    expect(isPartnerRole(ROLE_ALI)).toBe(true)
    expect(isPartnerRole(ROLE_AFNAN)).toBe(true)
  })

  it('returns false for Founder role', () => {
    expect(isPartnerRole(ROLE_FOUNDER)).toBe(false)
  })

  it('returns false for custom roles', () => {
    expect(isPartnerRole('staff')).toBe(false)
    expect(isPartnerRole('manager')).toBe(false)
    expect(isPartnerRole('custom_role')).toBe(false)
  })

  it('returns false for undefined or empty strings', () => {
    expect(isPartnerRole(undefined)).toBe(false)
    expect(isPartnerRole('')).toBe(false)
  })
})
