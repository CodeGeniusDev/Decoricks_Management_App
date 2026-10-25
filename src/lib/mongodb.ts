import { MongoClient, type Db } from 'mongodb'
import { getEnv } from './env'
import {
  resolveDatabase,
  bareProdTestWarning,
  productionDatabaseRefusal,
  type DatabaseNameSource,
} from './db-name'
import { isTransientMongoError } from './mongo-errors'
import { timeStage } from './timing'

export { isTransientMongoError } from './mongo-errors'

let client: MongoClient | undefined
let clientPromise: Promise<MongoClient> | null = null

// In development mode, use a global variable to preserve the connection
// across hot reloads. In production, this is not needed.
declare global {
  // eslint-disable-next-line no-var
  var _mongoClientPromise: Promise<MongoClient> | null | undefined
}

/**
 * Resolves the database name for the current process.
 *
 * The policy lives in `src/lib/db-name.ts` so the application and the
 * maintenance scripts cannot disagree about which database they are in; this
 * wrapper keeps the reporting (a resolved name is announced once, a
 * configuration that fell through to the driver default is complained about
 * once) out of the hot path.
 *
 * Announcing the name is not a nicety: with an Atlas URI whose path is empty,
 * the driver silently opens a database called `test`. The deployment's real
 * records happen to live there, which is precisely why the fallback is kept —
 * but an operator needs to see which database every request is reading, and
 * needs to see it once per process rather than per call.
 */
let announcedDatabase: string | undefined

const announceDatabase = (dbName: string, source: DatabaseNameSource, warning?: string): void => {
  if (announcedDatabase === dbName) return
  announcedDatabase = dbName

  if (warning) console.warn(`[mongodb] using database "${dbName}" (${source}) — ${warning}`)
  else console.log(`[mongodb] using database "${dbName}" (${source})`)
}

const resolveDbName = (): {
  dbName: string | undefined
  source: DatabaseNameSource
  warning?: string
} => resolveDatabase()

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Connection-pool tuning only. TLS is never disabled or downgraded: the URI
 * still negotiates TLS exactly as before, and `retryWrites`/`retryReads` use the
 * driver's built-in semantics rather than re-running writes blindly.
 *
 * `minPoolSize` is 2 rather than 0 because of a measurement, not a hunch
 * (Phase 4 §1, `scripts/db-probe.ts`): a single indexed point read against this
 * cluster costs ~65ms, while a read that has to *open* a connection costs
 * ~300-400ms. With `minPoolSize: 0` the pool drains whenever the app is idle, so
 * the first request after a pause — and every extra connection an intra-request
 * `Promise.all` needs — pays that full handshake. Two permanently-warm
 * connections cost almost nothing idle and make concurrent reads actually
 * concurrent.
 */
const driverOptions = () => ({
  maxPoolSize: 10,
  minPoolSize: 2,
  // Atlas (and some local proxies) close idle connections; dropping our side
  // first avoids handing a request to a socket the server has already gone.
  maxIdleTimeMS: 120_000,
  connectTimeoutMS: 15_000,
  serverSelectionTimeoutMS: 10_000,
  heartbeatFrequencyMS: 10_000,
  retryWrites: true,
  retryReads: true,
})

const getClientPromise = (): Promise<MongoClient> => {
  if (clientPromise) return clientPromise

  const env = getEnv()

  if (process.env.NODE_ENV === 'development') {
    if (!global._mongoClientPromise) {
      client = new MongoClient(env.MONGODB_URI, driverOptions())
      global._mongoClientPromise = client.connect()
    }
    clientPromise = global._mongoClientPromise
  } else {
    client = new MongoClient(env.MONGODB_URI, driverOptions())
    clientPromise = client.connect()
  }

  return clientPromise
}

/**
 * Drops the cached client so the next acquisition opens a fresh pool. The
 * driver flags handshake/pool failures with the `ResetPool` label; a pool that
 * just failed its TLS negotiation will keep failing until it is discarded.
 */
export const resetMongoClient = async (): Promise<void> => {
  const stale = clientPromise ?? global._mongoClientPromise ?? null
  clientPromise = null
  global._mongoClientPromise = undefined
  client = undefined

  if (stale) {
    try {
      const resolved = await stale
      await resolved.close(true)
    } catch {
      // The pool is already broken; a close failure is not actionable.
    }
  }
}

const connectWithRetry = async (attempts = 3): Promise<MongoClient> => {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await getClientPromise()
    } catch (error) {
      lastError = error
      if (!isTransientMongoError(error) || attempt === attempts - 1) break
      await resetMongoClient()
      await delay(200 * (attempt + 1))
    }
  }
  throw lastError
}

/**
 * Runs a database operation with a bounded retry on *transient* failures only.
 *
 * Non-transient errors (validation, duplicate key, authorization) propagate on
 * the first attempt. Each retry discards the failed pool first, so a request
 * that lost its TLS session reconnects instead of reusing it. `attempts` is
 * capped at 3 to bound worst-case latency.
 */
export const withMongoRetry = async <T>(operation: () => Promise<T>, attempts = 3): Promise<T> => {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!isTransientMongoError(error) || attempt === attempts - 1) throw error
      await resetMongoClient()
      await delay(200 * (attempt + 1))
    }
  }
  throw lastError
}

export async function getDatabase(): Promise<Db> {
  /*
   * `db:acquire` is the pool, not a query: on a warm instance the connect promise
   * is already resolved and this reports ~0ms. When it is not ~0ms the request paid
   * a handshake, which is the difference Phase 4 §2 asks to see (and the reason
   * `minPoolSize` is 2). Nested inside it are the request's own stages, so the two
   * numbers are read side by side, not added.
   */
  return timeStage('db:acquire', async () => {
    // Resolved outside the try so a misconfiguration surfaces as a clear config
    // error rather than a misleading "connection failed".
    const { dbName, source, warning } = resolveDbName()

    // The bare-`test`-in-production hazard is refused here, before any socket is
    // opened: a production process (not a test runner) resolving to `test`, a
    // `decoricks_test` / `test_*` sandbox, or nothing at all (driver falls back to
    // `test`) must serve zero requests. `resolveDatabase` already normalises the
    // driver-default case to `dbName: undefined`, so the refusal sees it too.
    // Elsewhere (dev) the same condition stays a loud, non-fatal warning.
    const refusal = productionDatabaseRefusal(
      { dbName, source },
      { nodeEnv: process.env.NODE_ENV ?? '', inTestRunner: process.env.E2E_TEST_MODE === '1' }
    )
    if (refusal) throw new Error(`[mongodb] ${refusal}`)

    try {
      const connected = await connectWithRetry()
      const db = connected.db(dbName)
      // `db.databaseName` is the name that will actually be used, which is the only
      // way to report the driver-default case honestly, and the reason dev still
      // gets the advisory bare-`test` warning rather than a crash.
      const bareTest = bareProdTestWarning(db.databaseName)
      const combinedWarning = [warning, bareTest].filter(Boolean).join(' ')
      announceDatabase(db.databaseName, source, combinedWarning || undefined)
      return db
    } catch {
      // Never surface the connection string, host names, or driver internals.
      console.error('[mongodb] database connection failed')
      throw new Error('Database connection failed')
    }
  })
}

/**
 * The underlying connected client. Needed by routes that must run several
 * writes inside a single transaction, which `Db` alone cannot start.
 */
export async function getMongoClient(): Promise<MongoClient> {
  return connectWithRetry()
}

export async function closeDatabase(): Promise<void> {
  try {
    await resetMongoClient()
  } catch {
    console.error('[mongodb] failed to close the database client')
  }
}

// Health check function
export async function healthCheck(): Promise<{ status: string; message: string }> {
  try {
    const db = await getDatabase()
    await db.admin().ping()
    return { status: 'healthy', message: 'Database connection successful' }
  } catch {
    console.error('[mongodb] database health check failed')
    return { status: 'unhealthy', message: 'Database connection failed' }
  }
}
