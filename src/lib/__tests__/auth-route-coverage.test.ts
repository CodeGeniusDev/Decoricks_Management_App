import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

function walk(dir: string, files: string[] = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    const s = statSync(p)
    if (s.isDirectory()) walk(p, files)
    else if (f === 'route.ts') files.push(p)
  }
  return files
}

describe('api route authorization coverage', () => {
  it('every non-public API route uses withAuth/requireAuth/authorize/requireFounder', () => {
    const routes = walk('src/app/api')
    const publicRoutes = new Set([
      'src/app/api/auth/login/route.ts',
      'src/app/api/auth/logout/route.ts',
      'src/app/api/health/route.ts',
      // /api/health/database is NOT public: it makes a real DB round trip and is
      // a Founder-only operator diagnostic (requireFounder), so it belongs to the
      // protected set below. Only the DB-free liveness probe stays public.
      //
      // DELIBERATE EXCEPTION, not an oversight: /api/cron/notifications is
      // called by an external cron service that has no session, so it cannot
      // use any of the four markers this test looks for. It is authenticated by
      // the `x-cron-secret` shared-secret header (`CRON_SECRET`, constant-time,
      // minimum length 32) instead — and when that variable is unset the route
      // answers 404 and runs nothing, so an unconfigured deployment exposes no
      // surface at all. Failures are rate limited per IP plus a process-wide
      // backstop, the response carries counts only, and middleware admits this
      // one exact path without a cookie (src/middleware.ts). Removing the header
      // check would be a real hole, so the route is covered by its own suite:
      // see src/lib/__tests__/cron-notifications-route.test.ts.
      'src/app/api/cron/notifications/route.ts',
    ])
    const missing: string[] = []
    for (const r of routes) {
      if (publicRoutes.has(r)) continue
      const t = readFileSync(r, 'utf8')
      const has = /withAuth|requireAuth|authorize\s*\(|requireFounder/.test(t)
      if (!has) missing.push(r)
    }
    expect(missing).toEqual([])
  })
})
