import { getEnv } from './env'

/**
 * Single source of truth for *which MongoDB database this application talks to*
 * (Phase 5 §5).
 *
 * Why this exists as its own module rather than staying inside `mongodb.ts`:
 * the maintenance scripts (`scripts/seed*.ts`, `scripts/cleanup-e2e-data.ts`,
 * `scripts/migrate-tasks-assignees.ts`) open their own `MongoClient` and were
 * each resolving the database independently. One of them used `client.db()`
 * while the app used `connected.db(undefined)` — harmless only as long as both
 * happen to hit the same fallback. Any resolution that a script can disagree
 * with is a resolution that can point a `deleteMany` at the wrong database.
 *
 * Resolution order, first match wins:
 *   1. `MONGODB_TEST_DB` — test runners only, refuses to apply elsewhere.
 *   2. `MONGODB_DB` — explicit operator override.
 *   3. The `MONGODB_URI` path component.
 *   4. `undefined`, i.e. the driver's own default.
 *
 * The 4th case is not hypothetical. The Atlas "Connect" URI copied from the
 * console has an *empty* path, and the driver then opens a database named
 * `test`. That is where this deployment's genuine records actually live
 * (`scripts/db-inventory.ts`: 31 collections, users/roles/sessions/messages/
 * transactions all present in `test`), so the fallback is preserved rather than
 * turned into a hard error — but it is reported, and it is no longer silent.
 */
export type DatabaseNameSource = 'MONGODB_TEST_DB' | 'MONGODB_DB' | 'MONGODB_URI' | 'driver default'

export interface ResolvedDatabase {
  /** `undefined` means "whatever the driver defaults to" — see above. */
  dbName: string | undefined
  source: DatabaseNameSource
  /** Set when the resolution is valid but the operator should still act on it. */
  warning?: string
}

/** Databases that hold server state; an application must never run against them. */
const RESERVED_DATABASES = new Set(['admin', 'local', 'config'])

/** MongoDB namespace limit; a longer name can never be reached. */
const MAX_DB_NAME_BYTES = 63

/** Characters MongoDB forbids in a database name. */
const INVALID_DB_CHARS = /[.$/\\ ]/

/**
 * Test-database shapes this project uses. Deliberately narrow: `decoricks_test`
 * (Vitest + Playwright) and anything prefixed `test_`. Note that a bare `test`
 * is NOT in this list — that name belongs to production in this deployment.
 */
export const TEST_DB_PATTERNS = [/^decoricks_test$/, /^test_[a-z0-9_]+$/i]

export const looksLikeTestDatabase = (name: string): boolean =>
  TEST_DB_PATTERNS.some((pattern) => pattern.test(name))

/**
 * The explicit operator opt-in required before any seed / migration / cleanup
 * script may write to a database that is NOT test-shaped.
 *
 * A bare `test` is not test-shaped here (see `TEST_DB_PATTERNS`) — in this
 * deployment it is the production database, reached because the Atlas URI has an
 * empty path and the driver falls back to `test`. Historically a maintenance
 * script inherited that fallback silently and could point a `updateOne` /
 * `deleteMany` at real data. This guard closes that door: a script must either
 * target a sandbox (`decoricks_test` / `test_*`) or be run with the flag set.
 */
export const PROD_DB_CONSENT_FLAG = 'DECORICKS_ALLOW_PROD_DB'

/**
 * Throws unless `dbName` is either a test-shaped sandbox or the operator has set
 * `DECORICKS_ALLOW_PROD_DB=1`. Call it in every writing script immediately after
 * the `client.db(...)` handle exists and before any operation that mutates data,
 * passing `db.databaseName` (which resolves the driver-default `test` too).
 *
 * `looksLikeTestDatabase` short-circuits first, so the hermetic suites
 * (`NODE_ENV=test`, `E2E_TEST_MODE=1`) never need the flag.
 */
export const assertScriptDatabaseConsent = (
  dbName: string,
  opts: { script: string; env?: Record<string, string | undefined> }
): void => {
  if (looksLikeTestDatabase(dbName)) return
  const env = opts.env ?? process.env
  if (env[PROD_DB_CONSENT_FLAG] === '1') return
  throw new Error(
    `Refusing to run ${opts.script} against "${dbName}": it is not a test-shaped database, ` +
      `so it is treated as holding real data. Re-run with ${PROD_DB_CONSENT_FLAG}=1 only if you ` +
      `intend to write to this database.`
  )
}

const fail = (message: string): never => {
  throw new Error(`Database configuration error: ${message}`)
}

/**
 * Reads the default database out of a connection string.
 *
 * `mongodb+srv://user:pass@host.example/decoricks?retryWrites=true` → `decoricks`
 * `mongodb://localhost:27017/?readPreference=primary` → `undefined` (empty path)
 * `mongodb://localhost:27017` → `undefined` (no path at all)
 *
 * The authority section is dropped from the *last* `@`, because a password may
 * legitimately contain an unencoded-looking `@` only when percent-encoded, while
 * the delimiter is always the final one. Options are cut at the first `?`.
 */
export const uriDefaultDatabase = (uri: string): string | undefined => {
  const trimmed = uri.trim()
  if (!/^mongodb(\+srv)?:\/\//i.test(trimmed)) return undefined

  const withoutScheme = trimmed.replace(/^mongodb(\+srv)?:\/\//i, '')
  const authorityEnd = withoutScheme.lastIndexOf('@')
  const hostsAndPath = withoutScheme.slice(authorityEnd + 1)

  const pathStart = hostsAndPath.indexOf('/')
  if (pathStart === -1) return undefined

  const name = hostsAndPath
    .slice(pathStart + 1)
    .split('?')[0]
    .trim()
  if (!name) return undefined

  try {
    return decodeURIComponent(name)
  } catch {
    return fail(
      `MONGODB_URI default database ${JSON.stringify(name)} is not valid percent-encoding`
    )
  }
}

/**
 * Validates a database name against MongoDB's own rules plus the reserved set,
 * so a typo in `MONGODB_DB` fails loudly at boot instead of quietly opening an
 * empty database and writing new records there.
 */
export const validateDatabaseName = (
  name: string,
  source: 'MONGODB_DB' | 'MONGODB_URI' | 'MONGODB_TEST_DB'
): string => {
  const value = name.trim()
  if (!value) fail(`${source} is set but empty`)
  if (value.length > MAX_DB_NAME_BYTES) {
    fail(`${source} must be at most ${MAX_DB_NAME_BYTES} characters (got ${value.length})`)
  }
  if (INVALID_DB_CHARS.test(value)) {
    fail(
      `${source} may not contain a period, dollar sign, slash, backslash or space (got ${JSON.stringify(value)})`
    )
  }
  if (RESERVED_DATABASES.has(value.toLowerCase())) {
    fail(`${source} may not point at the reserved database ${JSON.stringify(value)}`)
  }
  return value
}

interface DbEnv {
  MONGODB_URI: string
  MONGODB_DB?: string
  MONGODB_TEST_DB?: string
  NODE_ENV: 'development' | 'production' | 'test'
}

/** True when this process is an automated test runner (Vitest or the E2E server). */
export const isInTestRunner = (env: DbEnv = getEnv()): boolean =>
  env.NODE_ENV === 'test' || process.env.E2E_TEST_MODE === '1'

/**
 * A LOUD but NON-FATAL warning for the case that used to be silent: an app or a
 * maintenance script resolving to the bare database name `test` while NOT in a
 * test runner. In this deployment `test` holds the real business data — the Atlas
 * URI has an empty path, so the driver falls back to `test`, and `MONGODB_DB=test`
 * points the app straight at it. Running against `test` in dev/prod therefore
 * means running against production.
 *
 * It WARNS rather than crashes on purpose: refusing to boot would deny the
 * operator access to their own data, which is worse than a console warning. The
 * test-runner check is injectable so the wording can be unit-tested regardless of
 * the ambient NODE_ENV (the Vitest process itself runs under NODE_ENV=test).
 */
export const bareProdTestWarning = (
  databaseName: string,
  inTestRunner: boolean = isInTestRunner()
): string | null => {
  if (databaseName !== 'test') return null
  if (inTestRunner) return null
  return (
    'resolved to the database named "test" OUTSIDE a test runner — in this ' +
    'deployment that is the LIVE PRODUCTION database. Set MONGODB_DB explicitly ' +
    '(decoricks_prod / decoricks_dev) unless you genuinely intend to run against it.'
  )
}

/**
 * Resolves the database for the current process. Throws on any configuration
 * that could put traffic or a maintenance script in the wrong database.
 *
 * `E2E_TEST_MODE` is read straight off `process.env` rather than the schema
 * because it is a runner flag, not application configuration — it exists only in
 * the `webServer.env` block of `playwright.config.ts`.
 */
export const resolveDatabase = (env: DbEnv = getEnv()): ResolvedDatabase => {
  if (env.MONGODB_TEST_DB) {
    const name = validateDatabaseName(env.MONGODB_TEST_DB, 'MONGODB_TEST_DB')
    const inTestRunner = isInTestRunner(env)
    if (!inTestRunner) {
      fail(
        'MONGODB_TEST_DB is set but the process is not a test runner (NODE_ENV is not "test" and E2E_TEST_MODE is not "1"). Refusing to use a test database outside the test runner.'
      )
    }
    return { dbName: name, source: 'MONGODB_TEST_DB' }
  }

  if (env.MONGODB_DB) {
    return { dbName: validateDatabaseName(env.MONGODB_DB, 'MONGODB_DB'), source: 'MONGODB_DB' }
  }

  const fromUri = uriDefaultDatabase(env.MONGODB_URI)
  if (fromUri) {
    return { dbName: validateDatabaseName(fromUri, 'MONGODB_URI'), source: 'MONGODB_URI' }
  }

  return {
    dbName: undefined,
    source: 'driver default',
    warning:
      "no database name is configured: MONGODB_DB is unset and MONGODB_URI has an empty path, so the driver falls back to its implicit default. Set MONGODB_DB to the database that actually holds this application's data.",
  }
}
