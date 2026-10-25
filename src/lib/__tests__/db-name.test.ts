import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  looksLikeTestDatabase,
  resolveDatabase,
  uriDefaultDatabase,
  validateDatabaseName,
  assertScriptDatabaseConsent,
  bareProdTestWarning,
  productionDatabaseRefusal,
  assertProductionRunnable,
  isInTestRunner,
  PROD_DB_CONSENT_FLAG,
  isProductionDatabaseName,
  type DatabaseNameSource,
} from '@/lib/db-name'

/**
 * Phase 5 §5 — database-resolution policy.
 *
 * The production risk this locks is silent, not dramatic: with the Atlas
 * "Connect" URI (empty path after the host) and no `MONGODB_DB`, the driver
 * opens a database named `test` and every collection lands there. Nothing
 * errors, `/api/health` is green, and the app is one copied URI away from
 * running against an empty database. `scripts/db-inventory.ts` measured that
 * this deployment's genuine records really are in `test`, so the fallback has to
 * keep working — the tests below pin the *ordering*, the *refusals*, and the
 * reporting, without changing today's effective database.
 */

const BASE = {
  MONGODB_URI: 'mongodb://localhost:27017',
  NODE_ENV: 'production' as const,
}

describe('uriDefaultDatabase', () => {
  it('reads a plain URI path', () => {
    expect(uriDefaultDatabase('mongodb://user:pass@host.example:27017/decoricks')).toBe('decoricks')
  })

  it('reads an SRV URI path with options', () => {
    expect(
      uriDefaultDatabase(
        'mongodb+srv://user:pass@cluster0.example.mongodb.net/decoricks?retryWrites=true&w=majority'
      )
    ).toBe('decoricks')
  })

  it('returns undefined for the Atlas default URI (empty path)', () => {
    expect(
      uriDefaultDatabase(
        'mongodb+srv://user:pass@cluster0.example.mongodb.net/?retryWrites=true&w=majority'
      )
    ).toBeUndefined()
  })

  it('returns undefined when there is no path at all', () => {
    expect(uriDefaultDatabase('mongodb://localhost:27017')).toBeUndefined()
    expect(
      uriDefaultDatabase('mongodb://user:pass@cluster0.example.mongodb.net/?tls=true')
    ).toBeUndefined()
  })

  it('splits on the last @ so an encoded credential cannot hide the path', () => {
    expect(uriDefaultDatabase('mongodb://user:p%40ss@host.example/decoricks')).toBe('decoricks')
  })

  it('percent-decodes the database name', () => {
    // %69 is 'i'; the point is that a URI-encoded name arrives decoded, so the
    // validation below sees the real characters.
    expect(uriDefaultDatabase('mongodb://host.example/decor%69cks')).toBe('decoricks')
  })

  it('ignores anything that is not a mongo URI', () => {
    expect(uriDefaultDatabase('')).toBeUndefined()
    expect(uriDefaultDatabase('postgres://host/db')).toBeUndefined()
  })
})

describe('validateDatabaseName', () => {
  it('accepts an ordinary name', () => {
    expect(validateDatabaseName('decoricks', 'MONGODB_DB')).toBe('decoricks')
  })

  it('trims', () => {
    expect(validateDatabaseName('  decoricks  ', 'MONGODB_DB')).toBe('decoricks')
  })

  it('refuses the server databases', () => {
    for (const name of ['admin', 'local', 'config', 'ADMIN']) {
      expect(() => validateDatabaseName(name, 'MONGODB_DB')).toThrow(/reserved database/)
    }
  })

  it('refuses names MongoDB cannot use', () => {
    expect(() => validateDatabaseName('my.db', 'MONGODB_DB')).toThrow(/may not contain/)
    expect(() => validateDatabaseName('my$db', 'MONGODB_DB')).toThrow(/may not contain/)
    expect(() => validateDatabaseName('a/b', 'MONGODB_DB')).toThrow(/may not contain/)
    expect(() => validateDatabaseName('has space', 'MONGODB_DB')).toThrow(/may not contain/)
  })

  it('refuses an empty or over-long name', () => {
    expect(() => validateDatabaseName('   ', 'MONGODB_DB')).toThrow(/set but empty/)
    expect(() => validateDatabaseName('x'.repeat(64), 'MONGODB_DB')).toThrow(/at most 63/)
  })

  it('names the offending variable in the message', () => {
    expect(() => validateDatabaseName('admin', 'MONGODB_URI')).toThrow(/MONGODB_URI/)
  })
})

describe('resolveDatabase', () => {
  const originalE2E = process.env.E2E_TEST_MODE

  beforeEach(() => {
    delete process.env.E2E_TEST_MODE
  })

  afterEach(() => {
    if (originalE2E === undefined) delete process.env.E2E_TEST_MODE
    else process.env.E2E_TEST_MODE = originalE2E
  })

  it('MONGODB_TEST_DB wins, but only inside a test runner', () => {
    process.env.E2E_TEST_MODE = '1'
    const resolved = resolveDatabase({
      ...BASE,
      MONGODB_URI: 'mongodb://host.example/decoricks',
      MONGODB_DB: 'decoricks',
      MONGODB_TEST_DB: 'decoricks_test',
    })
    expect(resolved.dbName).toBe('decoricks_test')
    expect(resolved.source).toBe<DatabaseNameSource>('MONGODB_TEST_DB')

    // The guard is about the *process*, not the value: the same variable outside a
    // test runner would silently move production traffic into the test database.
    delete process.env.E2E_TEST_MODE
    expect(() => resolveDatabase({ ...BASE, MONGODB_TEST_DB: 'decoricks_test' })).toThrow(
      /not a test runner/
    )
  })

  it('NODE_ENV=test alone is a test runner', () => {
    const resolved = resolveDatabase({
      ...BASE,
      NODE_ENV: 'test',
      MONGODB_TEST_DB: 'decoricks_test',
    })
    expect(resolved.dbName).toBe('decoricks_test')
  })

  it('a test runner can never be pointed at production by MONGODB_DB', () => {
    // The direction that matters: the suite sets MONGODB_TEST_DB, and a stray
    // MONGODB_DB in the same environment must not redirect Playwright/Vitest into
    // the application database.
    const resolved = resolveDatabase({
      ...BASE,
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://host.example/decoricks',
      MONGODB_DB: 'decoricks',
      MONGODB_TEST_DB: 'decoricks_test',
    })
    expect(resolved.dbName).toBe('decoricks_test')
  })

  it('MONGODB_DB beats the URI path', () => {
    const resolved = resolveDatabase({
      ...BASE,
      MONGODB_URI: 'mongodb://host.example/other_database',
      MONGODB_DB: 'decoricks',
    })
    expect(resolved.dbName).toBe('decoricks')
    expect(resolved.source).toBe<DatabaseNameSource>('MONGODB_DB')
    expect(resolved.warning).toBeUndefined()
  })

  it('the URI path is used when MONGODB_DB is absent', () => {
    const resolved = resolveDatabase({ ...BASE, MONGODB_URI: 'mongodb://host.example/decoricks' })
    expect(resolved.dbName).toBe('decoricks')
    expect(resolved.source).toBe<DatabaseNameSource>('MONGODB_URI')
    expect(resolved.warning).toBeUndefined()
  })

  it('falls back to the driver default and says so — this is the live production shape', () => {
    // Exactly what `.env.local` / `.env.example` contain today: no MONGODB_DB and
    // an Atlas URI with an empty path. Asserting the fallback stays `undefined`
    // is what guarantees the fix does not move the application off the database
    // where its real records live.
    const resolved = resolveDatabase({
      ...BASE,
      MONGODB_URI: 'mongodb+srv://user:pass@cluster0.example.net/?retryWrites=true',
    })
    expect(resolved.dbName).toBeUndefined()
    expect(resolved.source).toBe<DatabaseNameSource>('driver default')
    expect(resolved.warning).toMatch(/MONGODB_DB is unset/)
    expect(resolved.warning).toMatch(/empty path/)
  })

  it('refuses a reserved or malformed override instead of opening a new empty database', () => {
    expect(() => resolveDatabase({ ...BASE, MONGODB_DB: 'admin' })).toThrow(/reserved/)
    expect(() => resolveDatabase({ ...BASE, MONGODB_DB: 'decoricks.backup' })).toThrow(
      /may not contain/
    )
    expect(() => resolveDatabase({ ...BASE, NODE_ENV: 'test', MONGODB_TEST_DB: 'admin' })).toThrow(
      /reserved/
    )
  })
})

describe('looksLikeTestDatabase', () => {
  it('accepts the shapes the suites use', () => {
    expect(looksLikeTestDatabase('decoricks_test')).toBe(true)
    expect(looksLikeTestDatabase('test_phase5')).toBe(true)
  })

  it('rejects the production database name in this deployment', () => {
    // `test` is the driver's implicit default AND where the real records are, so
    // "sounds like a test" cannot be allowed to mean "safe to seed or wipe".
    expect(looksLikeTestDatabase('test')).toBe(false)
    expect(looksLikeTestDatabase('decoricks')).toBe(false)
    expect(looksLikeTestDatabase('decoricks_test_backup')).toBe(false)
  })
})

describe('assertScriptDatabaseConsent', () => {
  // An explicit `env` is passed everywhere so the guard is tested without
  // mutating the real `process.env`.
  const consent = { [PROD_DB_CONSENT_FLAG]: '1' }
  const none = {}

  it('always allows a test-shaped sandbox, flag or not', () => {
    expect(() => assertScriptDatabaseConsent('decoricks_test', { script: 'x.ts' })).not.toThrow()
    expect(() => assertScriptDatabaseConsent('test_phase5', { script: 'x.ts' })).not.toThrow()
    expect(() =>
      assertScriptDatabaseConsent('decoricks_test', { script: 'x.ts', env: none })
    ).not.toThrow()
  })

  it('refuses the real production database ("test") without the consent flag', () => {
    expect(() =>
      assertScriptDatabaseConsent('test', { script: 'scripts/seed.ts', env: none })
    ).toThrow(/Refusing to run scripts\/seed\.ts against "test"/)
    expect(() =>
      assertScriptDatabaseConsent('decoricks', { script: 'scripts/seed.ts', env: none })
    ).toThrow(/DECORICKS_ALLOW_PROD_DB/)
  })

  it('permits a non-test database only when DECORICKS_ALLOW_PROD_DB=1', () => {
    expect(() =>
      assertScriptDatabaseConsent('test', { script: 'x.ts', env: consent })
    ).not.toThrow()
    expect(() =>
      assertScriptDatabaseConsent('decoricks', { script: 'x.ts', env: consent })
    ).not.toThrow()
  })

  it('treats any other value of the flag as no consent', () => {
    expect(() =>
      assertScriptDatabaseConsent('test', {
        script: 'x.ts',
        env: { [PROD_DB_CONSENT_FLAG]: 'true' },
      })
    ).toThrow(/Refusing to run/)
  })
})

describe('bareProdTestWarning — warn (never crash) on the live "test" DB', () => {
  it('warns when the resolved name is the bare "test" outside a test runner', () => {
    const warning = bareProdTestWarning('test', false)
    expect(warning).toMatch(/OUTSIDE a test runner/)
    expect(warning).toMatch(/LIVE PRODUCTION/)
    // The warning is advisory: it must not tell the operator to abort.
    expect(warning).toMatch(/Set MONGODB_DB explicitly/)
  })

  it('stays silent inside a test runner (E2E/Vitest may legally use "test")', () => {
    expect(bareProdTestWarning('test', true)).toBeNull()
  })

  it('stays silent for any other database name, in or out of a runner', () => {
    for (const name of ['decoricks_prod', 'decoricks_dev', 'decoricks_test', 'test_extra']) {
      expect(bareProdTestWarning(name, false)).toBeNull()
      expect(bareProdTestWarning(name, true)).toBeNull()
    }
  })

  it('defaults the runner check to isInTestRunner rather than assuming one', () => {
    // NODE_ENV=test (Vitest' own process) is a runner, so the ambient default
    // must not warn — this is exactly why the parameter is injectable above.
    expect(isInTestRunner({ MONGODB_URI: 'mongodb://h', NODE_ENV: 'test' })).toBe(true)
    expect(isInTestRunner({ MONGODB_URI: 'mongodb://h', NODE_ENV: 'production' })).toBe(false)
    expect(
      bareProdTestWarning(
        'test',
        isInTestRunner({ MONGODB_URI: 'mongodb://h', NODE_ENV: 'production' })
      )
    ).not.toBeNull()
  })
})

describe('productionDatabaseRefusal / assertProductionRunnable — hard boot gate (Phase 11)', () => {
  const prod = { nodeEnv: 'production', inTestRunner: false }

  it('refuses a production process with no explicit database (driver would fall back to "test")', () => {
    const msg = productionDatabaseRefusal({ dbName: undefined, source: 'driver default' }, prod)
    expect(msg).toMatch(/no explicit database/)
    expect(msg).toMatch(/decoricks_prod/)
  })

  it('refuses the bare "test" database in production', () => {
    const msg = productionDatabaseRefusal({ dbName: 'test', source: 'MONGODB_DB' }, prod)
    expect(msg).toMatch(/against database "test"/)
    expect(msg).toMatch(/not a production database here/)
  })

  it('refuses a test-shaped sandbox in production', () => {
    for (const dbName of ['decoricks_test', 'test_abcd']) {
      const msg = productionDatabaseRefusal({ dbName, source: 'MONGODB_DB' }, prod)
      expect(msg).toMatch(/test-shaped sandbox/)
    }
  })

  it('allows the real production database', () => {
    expect(
      productionDatabaseRefusal({ dbName: 'decoricks_prod', source: 'MONGODB_DB' }, prod)
    ).toBeNull()
  })

  it('exempts a real test runner even under NODE_ENV=production (Playwright web-server)', () => {
    const runner = { nodeEnv: 'production', inTestRunner: true }
    expect(
      productionDatabaseRefusal({ dbName: 'test_e2e', source: 'MONGODB_DB' }, runner)
    ).toBeNull()
    expect(
      productionDatabaseRefusal({ dbName: 'test', source: 'driver default' }, runner)
    ).toBeNull()
  })

  it('is a no-op outside production (dev still only warns, never refuses)', () => {
    expect(
      productionDatabaseRefusal(
        { dbName: 'test', source: 'MONGODB_DB' },
        { nodeEnv: 'development', inTestRunner: false }
      )
    ).toBeNull()
  })

  it('assertProductionRunnable throws for every misconfigured production shape', () => {
    // No MONGODB_DB + empty-path URI → driver default → would land on "test".
    expect(() => assertProductionRunnable(BASE)).toThrow(/no explicit database/)
    expect(() =>
      assertProductionRunnable({
        MONGODB_URI: 'mongodb://h',
        MONGODB_DB: 'test',
        NODE_ENV: 'production',
      })
    ).toThrow(/against database "test"/)
    expect(() =>
      assertProductionRunnable({
        MONGODB_URI: 'mongodb://h',
        MONGODB_DB: 'decoricks_test',
        NODE_ENV: 'production',
      })
    ).toThrow(/test-shaped/)
  })

  it('assertProductionRunnable is silent for decoricks_prod and for any non-production env', () => {
    expect(() =>
      assertProductionRunnable({
        MONGODB_URI: 'mongodb://h',
        MONGODB_DB: 'decoricks_prod',
        NODE_ENV: 'production',
      })
    ).not.toThrow()
    expect(() =>
      assertProductionRunnable({ MONGODB_URI: 'mongodb://h', NODE_ENV: 'development' })
    ).not.toThrow()
  })
})

describe('isProductionDatabaseName — the absolute seed/restore gate (Stage 2)', () => {
  it('recognises only the exact live production name, case/space insensitive', () => {
    expect(isProductionDatabaseName('decoricks_prod')).toBe(true)
    expect(isProductionDatabaseName('DECORICKS_PROD')).toBe(true)
    expect(isProductionDatabaseName('  decoricks_prod  ')).toBe(true)
  })

  it('does not treat dev, test sandboxes, the bare legacy "test", or near-miss typos as production', () => {
    // A typo like decoricks_prod2 is NOT production and falls through to the
    // ordinary consent rules rather than being silently refused as prod.
    for (const name of [
      'decoricks_dev',
      'decoricks_test',
      'test',
      'test_e2e',
      'decoricks_prod2',
      'decoricks',
    ]) {
      expect(isProductionDatabaseName(name), `${name} is not the prod name`).toBe(false)
    }
  })

  it('is disjoint from looksLikeTestDatabase — a name is never both sandbox and production', () => {
    // The seed/restore guards rely on these two predicates being mutually
    // exclusive: seed refuses a test shape AND separately refuses production, so
    // overlap would make the messaging contradictory.
    for (const name of ['decoricks_prod', 'decoricks_test', 'test', 'test_ab', 'decoricks_dev']) {
      expect(isProductionDatabaseName(name) && looksLikeTestDatabase(name)).toBe(false)
    }
  })
})
