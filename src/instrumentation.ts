/**
 * Next.js only ever auto-invokes `register()` in this file — it does NOT treat
 * `instrumentation.node.ts` as special and will not load it on its own. Without
 * this bridge the boot-time `ensureAuthIndexes` call silently never runs, which
 * is exactly the failure we want to avoid: no unique index on `users.email`, no
 * TTL sweep on `sessions.expiresAt`, and an unindexed `tokenHash` lookup on the
 * hottest read path.
 *
 * `register()` runs on both the Edge and Node runtimes, so we branch on
 * `NEXT_RUNTIME` and pull the Node-only work in with a dynamic import. That
 * keeps this module Edge/build safe (nothing Node-specific is loaded at build)
 * while still firing the real work when the Node server starts.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { register: registerNode } = await import('./instrumentation.node')
    await registerNode()
  }
}
