/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV !== 'production'

const contentSecurityPolicy = [
  "default-src 'self'",
  // Next's App Router hydrates through inline bootstrap scripts. Without a
  // nonce pipeline (which needs middleware header rewriting for every request)
  // the practical floor is 'unsafe-inline'. Everything else stays self-only.
  isDev ? "script-src 'self' 'unsafe-eval' 'unsafe-inline'" : "script-src 'self' 'unsafe-inline'",
  // Tailwind and component libraries emit inline style attributes.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // XHR, fetch and the SSE stream all stay same-origin.
  "connect-src 'self'",
  // The push service worker and its caches.
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  // Only meaningful (and only safe) on the HTTPS deployment; in local dev it
  // would try to upgrade http://localhost asset requests.
  ...(isDev ? [] : ['upgrade-insecure-requests']),
].join('; ')

const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
]

if (!isDev) {
  securityHeaders.push({
    key: 'Strict-Transport-Security',
    value: 'max-age=31536000; includeSubDomains',
  })
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /*
   * Build output directory, overridable so a production build can never be
   * written on top of the `.next` folder a running dev server is reading from.
   *
   * Reproduced failure this prevents: with `next dev` on :3000 and a
   * `next build` + `next start` sharing the project, the build overwrites
   * `.next/server` while the dev server is mid-request. The dev server then
   * throws `ENOENT ... pages-manifest.json`, webpack `Caching failed for pack:
   * ENOENT ... rename 0.pack.gz_ -> 0.pack.gz`, and `Cannot find module
   * './5611.js'` — and the browser's half of the same event is
   * `Runtime ChunkLoadError: Loading chunk app/layout failed (timeout:
   * /_next/static/chunks/app/layout.js)`, because the chunk it was pointed at
   * has been deleted underneath it. That single collision explains the reported
   * chunk error, the repeated `Fast Refresh had to perform a full reload`
   * warnings, and navigations that only work after a manual reload.
   *
   * Default stays `.next`, so nothing about the normal dev flow or the Netlify
   * build changes. Only the isolated e2e/preview server opts into another
   * directory (see `scripts/start-prod-test.sh` and the Playwright `webServer`).
   */
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  /*
   * Dev-only, and turned off for one measured reason: the indicator's button is
   * a 36x36 floating box at x20-56 / y844-880 in a 1440x900 viewport, and the
   * sidebar's collapse toggle now lives in its own row at the foot of the rail
   * (x16-48 / y868-900) so it can share nothing with the brand mark. The
   * indicator paints above it and intercepts the click — Playwright cannot reach
   * the toggle while it is on. There is no horizontal escape inside a 64px rail,
   * so the indicator is the thing that moves. Production builds never render it;
   * compile status is in the terminal and route health is on /api/health.
   */
  devIndicators: false,
  // Allow cross-origin requests from localhost for development
  allowedDevOrigins: ['localhost:127.0.0.1', 'localhost::1'],
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

module.exports = nextConfig
