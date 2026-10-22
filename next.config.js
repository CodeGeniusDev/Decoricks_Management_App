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
  // Allow cross-origin requests from localhost for development
  allowedDevOrigins: ['localhost:127.0.0.1', 'localhost::1'],
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

module.exports = nextConfig
module.exports.contentSecurityPolicy = contentSecurityPolicy
module.exports.securityHeaders = securityHeaders
