
## Phase 10 (Checkpoint 1/2) - Deferred
- **React-render tests:** Deferred (see AUDIT). 
- **Legacy collection cleanup:** Deferred (E6/E7 and others Low) pending review.
- **npm audit:** 9 remaining vulnerabilities tracked (braces/@vitest/mocker) — overrides added where safe; breaking upgrades deferred.
- **Tailwind 4 / vitest 4–5:** Deferred to avoid breaking changes.
- **SSE/change streams hosting:** Requires persistent Node host; Vercel/serverless not reliable. Polling fallback exists. Decision deferred to Step 5.
- **Full Playwright e2e:** Long-running in this environment; scoped QA recommended.

## Phase 10 (Checkpoint 1/2) - Additional
- **In-memory rate limiters:** `loginRateLimiter`, `changePasswordRateLimiter`, `adminRateLimiter` are per-process only (not shared across instances). Use Redis/shared store for multi-instance.
- **CSP uses inline scripts:** `next.config.js` CSP allows `unsafe-inline` for Next.js hydration; consider nonce-based CSP if hardened further.
- **9 remaining npm audit findings:** Tracked (braces/@vitest/mocker etc.); overrides added where safe; breaking upgrades deferred.
- **Tailwind 4 and vitest 4/5 deferrals:** Deferred to avoid breaking changes.
- **React-render tests:** Deferred (no jsdom/RTL in this phase).
- **Legacy collections:** Cleanup deferred (E6/E7 and other Low items).
