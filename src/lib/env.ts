import { z } from 'zod'

/**
 * Runtime environment contract.
 *
 * SPEC.md §8.2 lists `NEXTAUTH_SECRET` / `NEXTAUTH_URL`, but NextAuth is not
 * installed and this app hand-rolls its session layer. Requiring those two
 * variables would have been misleading, so they are replaced by
 * `SESSION_SECRET` (spec §8.2 keeps the same "generate a 32-byte random
 * secret" intent) plus the session/lockout knobs from spec §10.1.1.
 */
const envSchema = z.object({
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Session lifetime. SPEC §10.1.1 Threat 2 / §10.2.1 Test 3 specified 30
  // minutes; the product requirement is now a 7-day *inactivity* timeout, so the
  // window restarts on each qualifying authenticated request.
  SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(7 * 24 * 60),

  // Minimum gap between session "slides" so a burst of requests does not turn
  // into a burst of writes. Background / auto-polling requests never slide.
  SESSION_SLIDE_INTERVAL_SECONDS: z.coerce.number().int().nonnegative().default(60),

  // Account lockout. SPEC §10.2.1 Test 2 is authoritative: 5 failed attempts
  // inside 15 minutes locks the account for 15 minutes.
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
  LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),

  // SPEC §10.1.1 Threat 1: min 12 characters, complexity required.
  PASSWORD_MIN_LENGTH: z.coerce.number().int().positive().default(12),
  BCRYPT_COST: z.coerce.number().int().min(10).max(15).default(12),

  /**
   * Database name used ONLY by the automated test suite. Tests connect to a
   * separate database (`decoricks_test`) so production data is never touched.
   * Unset in every deployed environment.
   */
  MONGODB_TEST_DB: z.string().min(1).optional(),

  /**
   * Phase 9 Web Push (VAPID). All OPTIONAL: when any is missing, `deliverPush`
   * is a silent no-op and the app falls back to in-app + browser notifications
   * while open (design §10). The private key and subject are server-only; the
   * public key is exposed to the client through a dedicated `/api/push/vapid-public-key`
   * route, never via `NEXT_PUBLIC_*` (so a dev leak cannot expose secrets).
   */
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  VAPID_SUBJECT: z.string().min(1).optional(),
})

// Validate environment variables at runtime (not build time)
let _env: z.infer<typeof envSchema> | null = null

export const getEnv = () => {
  if (_env) return _env

  try {
    _env = envSchema.parse({
      MONGODB_URI: process.env.MONGODB_URI,
      SESSION_SECRET: process.env.SESSION_SECRET,
      NODE_ENV: process.env.NODE_ENV || 'development',
      SESSION_TTL_MINUTES: process.env.SESSION_TTL_MINUTES,
      SESSION_SLIDE_INTERVAL_SECONDS: process.env.SESSION_SLIDE_INTERVAL_SECONDS,
      LOGIN_MAX_ATTEMPTS: process.env.LOGIN_MAX_ATTEMPTS,
      LOGIN_WINDOW_MINUTES: process.env.LOGIN_WINDOW_MINUTES,
      LOCKOUT_MINUTES: process.env.LOCKOUT_MINUTES,
      PASSWORD_MIN_LENGTH: process.env.PASSWORD_MIN_LENGTH,
      BCRYPT_COST: process.env.BCRYPT_COST,
      MONGODB_TEST_DB: process.env.MONGODB_TEST_DB,
      VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
      VAPID_SUBJECT: process.env.VAPID_SUBJECT,
    })
    return _env
  } catch (error) {
    if (error instanceof z.ZodError) {
      const missingVars = error.errors.map((e) => e.path.join('.')).join(', ')
      throw new Error(
        `Environment validation failed. Missing or invalid variables: ${missingVars}`
      )
    }
    throw error
  }
}

/** Test-only reset so suites can vary configuration between cases. */
export const __resetEnvForTests = () => {
  _env = null
}

// For backward compatibility
export const env = new Proxy({} as z.infer<typeof envSchema>, {
  get(target, prop) {
    return getEnv()[prop as keyof z.infer<typeof envSchema>]
  },
})