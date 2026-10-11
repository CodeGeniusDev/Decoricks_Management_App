import { MongoClient, type Db } from 'mongodb'
import { getEnv } from './env'
import { isTransientMongoError } from './mongo-errors'

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
 * The automated test suite sets `MONGODB_TEST_DB` so every suite runs against a
 * separate database (`decoricks_test`) and can never touch production data.
 * A guard refuses to hand out a test database handle unless the process is
 * actually running tests — either the Vitest runner (`NODE_ENV=test`) or the
 * Playwright-managed app server (`E2E_TEST_MODE=1`, set only by the webServer
 * block in `playwright.config.ts`) — so a stray env var in production cannot
 * silently redirect traffic.
 */
const resolveDbName = (): string | undefined => {
  const env = getEnv()
  const testDb = env.MONGODB_TEST_DB

  if (!testDb) return undefined

  const inTestRunner = env.NODE_ENV === 'test' || process.env.E2E_TEST_MODE === '1'
  if (!inTestRunner) {
    throw new Error(
      'MONGODB_TEST_DB is set but the process is not a test runner (NODE_ENV is not "test" and E2E_TEST_MODE is not "1"). Refusing to use a test database outside the test runner.'
    )
  }

  return testDb
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Connection-pool tuning only. TLS is never disabled or downgraded: the URI
 * still negotiates TLS exactly as before, and `retryWrites`/`retryReads` use the
 * driver's built-in semantics rather than re-running writes blindly.
 */
const driverOptions = () => ({
  maxPoolSize: 10,
  minPoolSize: 0,
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
  // Resolved outside the try so a misconfiguration surfaces as a clear config
  // error rather than a misleading "connection failed".
  const dbName = resolveDbName()

  try {
    const connected = await connectWithRetry()
    return connected.db(dbName)
  } catch {
    // Never surface the connection string, host names, or driver internals.
    console.error('[mongodb] database connection failed')
    throw new Error('Database connection failed')
  }
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
