import { describe, expect, it } from 'vitest'
import type { Db } from 'mongodb'
import {
  clearLoginAttempts,
  getLockoutStatus,
  normalizeIdentifier,
  recordLoginAttempt,
} from '@/lib/auth/lockout'

/**
 * SPEC §10.2.1 Test 2 is authoritative: five failed attempts inside 15 minutes
 * lock the account for 15 minutes; the window is sliding.
 *
 * The suite runs against an in-memory fake of the `loginAttempts` collection so
 * it does not need a live MongoDB, but it calls the real query/sort/limit paths.
 */

interface Attempt {
  identifier: string
  successful: boolean
  createdAt: Date
}

type DateRange = { $gte?: Date; $lt?: Date }

interface AttemptFilter {
  identifier?: string
  successful?: boolean
  createdAt?: { $gte?: Date; $lt?: Date }
}

const makeAttemptDb = () => {
  const attempts: Array<{
    identifier: string
    successful: boolean
    createdAt: Date
  }> = []

  const matches = (doc: (typeof attempts)[number], filter: Record<string, unknown>): boolean => {
    if ('identifier' in filter && doc.identifier !== filter.identifier) return false
    if ('successful' in filter && doc.successful !== filter.successful) return false
    const range = filter.createdAt as { $gte?: Date; $lt?: Date } | undefined
    if (range?.$gte && doc.createdAt < range.$gte) return false
    if (range?.$lt && doc.createdAt >= range.$lt) return false
    return true
  }

  const sorted = (filter: Record<string, unknown>) =>
    attempts
      .filter((attempt) => matches(attempt, filter))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

  const collection = {
    insertOne: async (doc: (typeof attempts)[number]) => {
      attempts.push(doc)
      return { insertedId: String(attempts.length) }
    },
    find: (filter: Record<string, unknown> = {}) => {
      const results = sorted(filter)
      return {
        sort: () => ({ limit: (n: number) => ({ toArray: async () => results.slice(0, n) }) }),
        toArray: async () => results,
      }
    },
    deleteMany: async (filter: Record<string, unknown> = {}) => {
      const kept = attempts.filter((attempt) => !matches(attempt, filter))
      const deletedCount = attempts.length - kept.length
      attempts.splice(0, attempts.length, ...kept)
      return { deletedCount }
    },
  }

  const db = {
    collection: (name: string) => {
      if (name !== 'loginAttempts') throw new Error(`Unexpected collection: ${name}`)
      return collection
    },
  } as unknown as Db

  return { db, attempts }
}

const makeDb = makeAttemptDb

const EMAIL = 'Hasnat@Decoricks.com'

describe('account lockout', () => {
  it('locks after 5 failed attempts inside the window (SPEC Test 2)', async () => {
    const { db } = makeDb()
    for (let i = 0; i < 5; i += 1) {
      await recordLoginAttempt(db, EMAIL, false)
    }
    const status = await getLockoutStatus(db, EMAIL)
    expect(status.locked).toBe(true)
    expect(status.failedAttempts).toBe(5)
    expect(status.retryAfterMinutes).toBeGreaterThan(0)
  })

  it('does not lock below the threshold', async () => {
    const { db } = makeDb()
    for (let i = 0; i < 4; i += 1) {
      await recordLoginAttempt(db, EMAIL, false)
    }
    await expect(getLockoutStatus(db, EMAIL)).resolves.toMatchObject({
      locked: false,
      failedAttempts: 4,
    })
  })

  it('ignores failures older than the sliding window', async () => {
    const { attempts, db } = makeDb()
    const stale = new Date(Date.now() - 20 * 60 * 1000)
    for (let i = 0; i < 5; i += 1) {
      attempts.push({ identifier: EMAIL.toLowerCase(), successful: false, createdAt: stale })
    }
    await expect(getLockoutStatus(db, EMAIL)).resolves.toMatchObject({
      locked: false,
      failedAttempts: 0,
    })
  })

  it('clears the failure history after a successful login', async () => {
    const { db } = makeDb()
    for (let i = 0; i < 5; i += 1) {
      await recordLoginAttempt(db, EMAIL, false)
    }
    await clearLoginAttempts(db, EMAIL)
    await expect(getLockoutStatus(db, EMAIL)).resolves.toMatchObject({
      locked: false,
      failedAttempts: 0,
    })
  })

  it('tracks attempts per normalised identifier', async () => {
    const { db } = makeDb()
    for (let i = 0; i < 5; i += 1) {
      await recordLoginAttempt(db, EMAIL, false)
    }
    await expect(getLockoutStatus(db, 'someone-else@decoricks.com')).resolves.toMatchObject({
      locked: false,
    })
    expect(normalizeIdentifier(EMAIL)).toBe(EMAIL.toLowerCase())
    await expect(getLockoutStatus(db, EMAIL.toUpperCase())).resolves.toMatchObject({ locked: true })
  })
})
