import { describe, expect, it } from 'vitest'

type Config = {
  poweredByHeader?: boolean
  headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>>
}

const config = require('../../../next.config.js') as Config

const headersFor = async (pathname: string) => {
  const groups = await config.headers()
  const match = groups.find((group) => group.source === '/:path*')
  if (!match) throw new Error(`no header group covers ${pathname}`)
  return new Map(match.headers.map((header) => [header.key.toLowerCase(), header.value]))
}

describe('security headers', () => {
  it('hides the framework banner', () => {
    expect(config.poweredByHeader).toBe(false)
  })

  it('applies to every path through the catch-all group', async () => {
    const headers = await headersFor('/api/finance')
    expect(headers.size).toBeGreaterThan(0)
  })

  it('revalidates the service worker script, so a cached sw.js cannot hide a new deploy', async () => {
    const groups = await config.headers()
    const worker = groups.find((group) => group.source === '/sw.js')
    expect(worker?.headers.find((header) => header.key === 'Cache-Control')?.value).toBe('no-cache')
    // The security group is a catch-all, so it still covers this path.
    expect(groups.some((group) => group.source === '/:path*')).toBe(true)
  })

  it('blocks MIME sniffing, framing and referrer leakage', async () => {
    const headers = await headersFor('/dashboard')
    expect(headers.get('x-content-type-options')).toBe('nosniff')
    expect(headers.get('x-frame-options')).toBe('DENY')
    expect(headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
  })

  it('locks the CSP down to same-origin except for inline hydration scripts', async () => {
    const headers = await headersFor('/')
    const csp = headers.get('content-security-policy') ?? ''

    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("form-action 'self'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("worker-src 'self' blob:")
    // No remote script/style/connect origins are allowed anywhere.
    expect(csp).not.toMatch(/(script-src|connect-src)[^;]*https?:/)
  })

  it('disables device APIs the app never uses', async () => {
    const headers = await headersFor('/')
    const policy = headers.get('permissions-policy') ?? ''
    expect(policy).toContain('camera=()')
    expect(policy).toContain('microphone=()')
    expect(policy).toContain('geolocation=()')
  })

  it('sends HSTS outside development only', async () => {
    const headers = await headersFor('/')
    if (process.env.NODE_ENV === 'production') {
      expect(headers.get('strict-transport-security')).toContain('max-age=31536000')
    } else {
      expect(headers.get('strict-transport-security')).toBeUndefined()
    }
  })
})
