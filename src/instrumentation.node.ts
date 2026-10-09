/**
 * Server-only instrumentation for Node runtime.
 */
export async function register(): Promise<void> {
  if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'development') return
  if (process.env.NEXT_PHASE === 'phase-production-build') return

  try {
    const { getDatabase } = await import('./lib/mongodb')
    const { ensureAuthIndexes } = await import('./lib/models/User')
    const db = await getDatabase()
    await ensureAuthIndexes(db)
  } catch (error) {
    console.error('[instrumentation] failed to ensure auth indexes', error)
  }
}
