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
