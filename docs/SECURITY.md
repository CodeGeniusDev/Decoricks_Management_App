# Security (Shipped Design)

## Authentication
- **Custom session auth** (no NextAuth). httpOnly cookies, `SameSite=Lax`, `Secure` in prod.
- **Session lifetime:** 12h sliding + 7d absolute max (env-configurable via `SESSION_TTL_MINUTES` / `SESSION_MAX_LIFETIME_MINUTES`).
- **CSRF:** fail-closed (`assertCsrf`). All non-GET state-changing requests require valid CSRF token.
- **Forced password change:** enforced by `requireAuth({ allowPasswordChange: true })` on `/api/auth/me` and `/api/auth/change-password`; all other authenticated routes require `passwordChangedAt` set.
- **Middleware:** `/change-password` and `/api/auth/change-password` require session; `/api/auth/login` public.

## Authorization
- **Server-side permission checks** via `requireAuth` + permission matrix. Client derives from `SPEC_ROLES` (single source of truth), no founder shortcut.
- **Route protection:** all mutating/privileged routes gated server-side.
- **Design route:** `/design` founder-gated → `notFound()` for non-founders.

## Brute force / Rate limiting
- **Login lockout:** `loginAttempts` with TTL index, ascending sort, trigger-based expiry, purge. Login skips recording on lockout.
- **IP rate limits:** `loginRateLimiter` (10/60s), `changePasswordRateLimiter` (5/60s), `adminRateLimiter` (30/60s). Applied to login/change-password/users/roles.

## Headers (next.config.js)
- `Strict-Transport-Security` + `upgrade-insecure-requests` (prod)
- `Content-Security-Policy` (same-origin; inline for Next hydration)
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy`
- `Cross-Origin-Opener-Policy: same-origin`
- `poweredByHeader: false`

## Secrets
- No hardcoded credentials in source/E2E helpers/probe/seed/diag scripts.
- Real secret scan clean (gitleaks full history). Rotation targets tracked separately.

## Data integrity
- Finance reversals transactional (`runInTransaction`), audit logged post-commit.
- Board/task idempotency via keys + partial unique index.
- Index migration helper (`scripts/index-migrate-dry-run.ts`) is read-only by default; apply requires backup flag.

## Realtime/Offline
- **SSE + polling fallback** (no WebSocket). Change streams require persistent Node host (polling works everywhere).
- **Offline:** finance+budget creates only; chat online-only. No server `offlineQueue`. Sequential sync.
- **Notifications:** user-scoped module.
