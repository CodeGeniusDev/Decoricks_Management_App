import { beforeEach, describe, expect, it } from 'vitest'
import type { Db } from 'mongodb'
import {
  canRecordLahoreStock,
  emptyRole,
  hasPermission,
  hasScopedGrant,
  invalidateRoleCache,
} from '@/lib/authorization'
import {
  ROLE_AFNAN,
  ROLE_ALI,
  ROLE_FOUNDER,
  ROLE_HASNAT,
  SCOPED_LAHORE_STOCK_PERMISSION,
  SCOPED_SALES_FULL_EDIT,
  SPEC_ROLES,
} from '@/lib/roles'

/**
 * These assertions pin the SPEC §4.2 matrix rather than the implementation.
 * `@/lib/authorization` is globally mocked to a permissive Founder in
 * `src/test/setup.ts`, but the pure helpers (`hasPermission`) and the
 * DB-backed scoped lookups below are the real exports (the mock spreads the
 * actual module), so this file exercises production logic.
 */

const fakeDb = (roles: Array<Record<string, unknown>> = []): Db =>
  ({
    collection: () => ({
      find: () => ({ toArray: async () => roles }),
    }),
  }) as unknown as Db

const roleByName = (name: string) => SPEC_ROLES.find((role) => role.name === name)!

beforeEach(() => {
  // `getRoles()` memoises for 2s; clear it so each case sees its own fake db.
  invalidateRoleCache()
})

describe('hasPermission', () => {
  it('grants the Founder every module action', () => {
    const founder = roleByName(ROLE_FOUNDER)
    for (const moduleName of ['finance', 'budget', 'inventory', 'sales', 'settings', 'users']) {
      expect(hasPermission(founder, moduleName, 'view'), `${moduleName}.view`).toBe(true)
    }
    expect(hasPermission(founder, 'finance', 'approve')).toBe(true)
    expect(hasPermission(founder, 'users', 'delete')).toBe(true)
  })

  it('denies users/settings management to every partner (SPEC §4.2 Founder-only)', () => {
    for (const name of [ROLE_HASNAT, ROLE_ALI, ROLE_AFNAN]) {
      const role = roleByName(name)
      expect(hasPermission(role, 'users', 'view'), `${name} users.view`).toBe(false)
      expect(hasPermission(role, 'users', 'create'), `${name} users.create`).toBe(false)
      expect(hasPermission(role, 'settings', 'view'), `${name} settings.view`).toBe(false)
    }
  })

  it('separates the partners on sales edits', () => {
    expect(hasPermission(roleByName(ROLE_HASNAT), 'sales', 'edit')).toBe(true)
    expect(hasPermission(roleByName(ROLE_HASNAT), 'sales', 'delete')).toBe(false)
    expect(hasPermission(roleByName(ROLE_ALI), 'sales', 'edit')).toBe(false)
    expect(hasPermission(roleByName(ROLE_AFNAN), 'sales', 'edit')).toBe(false)
  })

  it('keeps every role able to view and collaborate on tasks/chat', () => {
    for (const role of SPEC_ROLES) {
      expect(hasPermission(role, 'tasks', 'create'), `${role.name} tasks.create`).toBe(true)
      expect(hasPermission(role, 'chat', 'create'), `${role.name} chat.create`).toBe(true)
    }
  })

  it('fails closed for a missing role or unknown module/action', () => {
    expect(hasPermission(null, 'finance', 'view')).toBe(false)
    expect(hasPermission(undefined, 'finance', 'view')).toBe(false)
    expect(hasPermission(emptyRole('ghost'), 'finance', 'view')).toBe(false)
    expect(hasPermission(roleByName(ROLE_FOUNDER), 'nonexistent', 'view')).toBe(false)
    expect(hasPermission(roleByName(ROLE_FOUNDER), 'finance', 'launch')).toBe(false)
  })
})

describe('scoped grants', () => {
  it('applies the Lahore-stock default only to Hasnat, Ali and the Founder', async () => {
    await expect(hasScopedGrant(ROLE_FOUNDER, SCOPED_LAHORE_STOCK_PERMISSION, fakeDb())).resolves.toBe(true)
    await expect(hasScopedGrant(ROLE_HASNAT, SCOPED_LAHORE_STOCK_PERMISSION, fakeDb())).resolves.toBe(true)
    await expect(hasScopedGrant(ROLE_ALI, SCOPED_LAHORE_STOCK_PERMISSION, fakeDb())).resolves.toBe(true)
    await expect(hasScopedGrant(ROLE_AFNAN, SCOPED_LAHORE_STOCK_PERMISSION, fakeDb())).resolves.toBe(false)
  })

  it('keeps sales.full_edit Founder-only by default', async () => {
    await expect(hasScopedGrant(ROLE_FOUNDER, SCOPED_SALES_FULL_EDIT, fakeDb())).resolves.toBe(true)
    await expect(hasScopedGrant(ROLE_HASNAT, SCOPED_SALES_FULL_EDIT, fakeDb())).resolves.toBe(false)
    await expect(hasScopedGrant(ROLE_ALI, SCOPED_SALES_FULL_EDIT, fakeDb())).resolves.toBe(false)
  })

  it('lets a stored role override the default in both directions', async () => {
    const granted = fakeDb([
      { name: ROLE_AFNAN, permissions: { [SCOPED_LAHORE_STOCK_PERMISSION]: { create: true } } },
    ])
    await expect(hasScopedGrant(ROLE_AFNAN, SCOPED_LAHORE_STOCK_PERMISSION, granted)).resolves.toBe(true)

    invalidateRoleCache()
    const revoked = fakeDb([
      { name: ROLE_HASNAT, permissions: { [SCOPED_LAHORE_STOCK_PERMISSION]: { create: false } } },
    ])
    await expect(hasScopedGrant(ROLE_HASNAT, SCOPED_LAHORE_STOCK_PERMISSION, revoked)).resolves.toBe(false)
  })

  it('canRecordLahoreStock mirrors the scoped default', async () => {
    await expect(canRecordLahoreStock(ROLE_HASNAT, fakeDb())).resolves.toBe(true)
    await expect(canRecordLahoreStock(ROLE_AFNAN, fakeDb())).resolves.toBe(false)
  })
})
