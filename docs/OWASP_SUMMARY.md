# OWASP Summary (Phase 10)

## NoSQL operator injection

- All user-supplied search/filters use regex with escaped input where used (audit log) or Zod validation.
- MongoDB queries use ObjectId parsing and schema validation; avoid passing raw objects.
- Rate limiting and authz on sensitive endpoints.

## XSS

- React escapes by default; CSP headers added (inline for Next hydration).
- No `dangerouslySetInnerHTML` used in new code paths reviewed.
- User content rendered via React components.

## IDOR

- All routes use `requireAuth`/`withAuth`/`authorize`/`requireFounder` with server-side permission checks.
- Row-level checks (e.g. tasks) enforced.
- Design route founder-gated and returns 404.

## Mass assignment

- Zod schemas with `.strict()` used on mutation endpoints (roles/users/tasks/etc.)
- Explicit field allowlists in updates.
- No direct pass-through of request body to DB updates.
