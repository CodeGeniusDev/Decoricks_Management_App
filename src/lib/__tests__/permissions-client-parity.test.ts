import { describe, expect, it, afterEach } from 'vitest'
import { can, setLivePermissions } from '@/lib/permissions-client'
import {
  ALL_PERMISSION_ACTIONS,
  PERMISSION_MODULES,
  ROLE_AFNAN,
  ROLE_ALI,
  ROLE_FOUNDER,
  ROLE_HASNAT,
  SPEC_ROLES,
} from '@/lib/roles'

/**
 * The client helper is display-only, but it must agree with the matrix the
 * server seeds. It previously carried a second hand-written copy of the
 * defaults, which drifted (partners lost `tasks.comment`, the Founder gained
 * settings actions it does not have). These assertions keep the two in step by
 * checking every role, module and action rather than a few spot values.
 */
describe('client permission defaults match the seeded roles', () => {
  afterEach(() => setLivePermissions(null))

  for (const role of SPEC_ROLES) {
    it(`matches every grant for ${role.name}`, () => {
      for (const mod of PERMISSION_MODULES) {
        for (const action of ALL_PERMISSION_ACTIONS) {
          const expected = role.permissions[mod]?.[action] === true
          expect(
            can({ role: role.name }, mod, action),
            `${role.name}.${mod}.${action}`
          ).toBe(expected)
        }
      }
    })
  }

  it('keeps board actions visible to partners', () => {
    for (const role of [ROLE_HASNAT, ROLE_ALI, ROLE_AFNAN]) {
      expect(can({ role }, 'tasks', 'comment')).toBe(true)
      expect(can({ role }, 'tasks', 'manage')).toBe(false)
      expect(can({ role }, 'tasks', 'editOthers')).toBe(false)
    }
  })

  it('does not give the Founder settings actions the role lacks', () => {
    expect(can({ role: ROLE_FOUNDER }, 'settings', 'view')).toBe(true)
    expect(can({ role: ROLE_FOUNDER }, 'settings', 'edit')).toBe(true)
    expect(can({ role: ROLE_FOUNDER }, 'settings', 'create')).toBe(false)
    expect(can({ role: ROLE_FOUNDER }, 'settings', 'delete')).toBe(false)
  })

  it('prefers an explicit live matrix over the defaults', () => {
    setLivePermissions({ sales: { view: false, create: false } })
    expect(can({ role: ROLE_HASNAT }, 'sales', 'create')).toBe(false)
    expect(can({ role: ROLE_HASNAT }, 'sales', 'view')).toBe(false)
    // Modules the live matrix omits are denied, not silently defaulted.
    expect(can({ role: ROLE_HASNAT }, 'finance', 'view')).toBe(false)

    setLivePermissions(null)
    expect(can({ role: ROLE_HASNAT }, 'sales', 'create')).toBe(true)
  })
})
