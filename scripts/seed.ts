import { MongoClient } from 'mongodb'
import { getEnv } from '../src/lib/env'
import { SPEC_ROLES, LAHORE_STOCK_ROLES, SCOPED_LAHORE_STOCK_PERMISSION } from '../src/lib/roles'
import { hashPassword } from '../src/lib/auth/password'
import type { Role, User } from '../src/lib/models/User'

/**
 * Seeds the two things Phase 2 cannot work without:
 *
 *   1. The four SPEC role documents (founder, partner_hasnat, partner_ali,
 *      partner_afnan) with the §4.2 matrix baked in.
 *   2. The first Founder account, created from environment credentials with
 *      `mustChangePassword: true` so the bootstrap password cannot keep working.
 *
 * Safe to re-run: roles are upserted, and the Founder is only inserted when no
 * Founder exists. Re-running never overwrites an existing user's password.
 *
 * Usage:
 *   FOUNDER_EMAIL=... FOUNDER_NAME=... FOUNDER_PASSWORD=... npm run seed
 */

const FOUNDER_EMAIL = process.env.FOUNDER_EMAIL
const FOUNDER_NAME = process.env.FOUNDER_NAME
const FOUNDER_PASSWORD = process.env.FOUNDER_PASSWORD

const upsertRoles = async (db: ReturnType<MongoClient['db']>) => {
  const now = new Date()

  for (const spec of SPEC_ROLES) {
    // The Lahore stock exception is stored alongside the matrix so the
    // permissions screen can show and toggle it.
    const permissions = {
      ...spec.permissions,
      [SCOPED_LAHORE_STOCK_PERMISSION]: {
        view: LAHORE_STOCK_ROLES[spec.name] === true,
        create: LAHORE_STOCK_ROLES[spec.name] === true,
        edit: false,
        delete: false,
      },
    }

    // `$setOnInsert` only: a re-run must never clobber permissions a Founder
    // has since customised in the permissions matrix screen.
    await db.collection<Role>('roles').updateOne(
      { name: spec.name },
      {
        $setOnInsert: {
          name: spec.name,
          displayName: spec.displayName,
          permissions,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true }
    )
  }

  return SPEC_ROLES.length
}

const seedFounder = async (db: ReturnType<MongoClient['db']>, passwordHash: string) => {
  const existing = await db.collection<User>('users').findOne({ role: 'founder' })
  if (existing) {
    console.log(`Founder already exists (${existing.email}) — left untouched.`)
    return 0
  }

  const now = new Date()
  const founder: User = {
    email: FOUNDER_EMAIL!.trim().toLowerCase(),
    passwordHash,
    name: FOUNDER_NAME!.trim(),
    role: 'founder',
    isActive: true,
    mustChangePassword: true,
    createdAt: now,
    updatedAt: now,
    sessionVersion: 1,
  }

  await db.collection<User>('users').insertOne(founder)
  return 1
}

const main = async () => {
  const missing = (['FOUNDER_EMAIL', 'FOUNDER_NAME', 'FOUNDER_PASSWORD'] as const).filter(
    (key) => !process.env[key]
  )
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(', ')}`)
    console.error('Set them in .env.local, e.g.')
    console.error('  FOUNDER_EMAIL=founder@decoricks.pk')
    console.error('  FOUNDER_NAME=Abdullah')
    console.error('  FOUNDER_PASSWORD=<at least 12 chars, upper+lower+number>')
    process.exit(1)
  }

  // Refuse to point the seed at the test database by accident, and vice versa.
  const env = getEnv()
  if (env.MONGODB_TEST_DB) {
    console.error('MONGODB_TEST_DB is set; refusing to run the seed against a test database.')
    process.exit(1)
  }

  const client = new MongoClient(env.MONGODB_URI)
  try {
    await client.connect()
    const db = client.db()

    const roleCount = await upsertRoles(db)
    console.log(`Seeded ${roleCount} roles from SPEC.md Appendix A.`)

    const passwordHash = await hashPassword(FOUNDER_PASSWORD!)
    const founderCount = await seedFounder(db, passwordHash)
    if (founderCount === 1) {
      console.log(`Created Founder ${FOUNDER_EMAIL} — password change required on first login.`)
    }
  } finally {
    await client.close()
  }
}

main().catch((error) => {
  console.error('Seed failed:', error)
  process.exit(1)
})