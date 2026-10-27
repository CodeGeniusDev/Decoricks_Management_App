# E2E Runbook

## Prerequisites

- Node 18+ / 20+, npm
- MongoDB instance (local or Atlas) - MUST use a separate test database
- Playwright browsers installed: `npx playwright install`

## Environment variables (set on Mac)

```bash
# REQUIRED - must contain 'test' or 'e2e'
export MONGODB_TEST_DB=decoricks_test_e2e
export MONGODB_URI=mongodb://localhost:27017

# OR use full URI
# export MONGODB_URI=mongodb+srv://...
# export MONGODB_TEST_DB=decoricks_test_e2e

# E2E mode
export E2E_TEST_MODE=true
export NODE_ENV=test

# Base URL (optional, defaults to http://localhost:3000)
export PLAYWRIGHT_BASE_URL=http://localhost:3000

# E2E users (must exist in test DB)
export E2E_FOUNDER_EMAIL=founder@decoricks.com
export E2E_AFNAN_EMAIL=afnan@decoricks.com
export E2E_PASSWORD=<test-password>
```

## Safety check

The test suite will REFUSE to run if database name does not contain 'test' or 'e2e'.

## Setup

1. Start MongoDB (local) or ensure test DB accessible
2. Seed test database: `npx ts-node scripts/seed-e2e.ts` or let setup handle it
3. Install browsers: `npx playwright install`

## Run commands

```bash
# Run all e2e
npx playwright test

# Run specific spec
npx playwright test src/e2e/layout.spec.ts

# Run with specific project
npx playwright test src/e2e/layout.spec.ts --project=chromium

# Run design tests on all 3 device projects
npx playwright test src/e2e/layout.spec.ts --project=chromium --project="Mobile Chrome" --project="Tablet"
```

## Notes

- Never point to production database
- Auth setup requires seeded users in test DB

## Known failure on a re-seeded test DB

`src/e2e/phase3-collab.spec.ts` — "a mention picked from the autocomplete
persists, alerts the teammate, and deep-links the room" fails on a test DB that
holds more than one active user with the same display name, which is what
`scripts/seed-e2e.ts` leaves behind when it is run with different
`E2E_FOUNDER_EMAIL` / `E2E_AFNAN_EMAIL` values (the Oct 21 `@decoricks.com` pair
and the Oct 25 `@decoricks.test` pair both stay active).

Why the name is the problem: the composer sends text, not an id, and
`findMentions` (`src/lib/chat-mentions.ts`) rebuilds identity by looking the
display name up in a `Map` that is filled in `_id` order — last write wins. So
`@E2E Afnan` resolves to the newest duplicate, `emitNotification` writes the
alert to that account, and device B (logged in as the older one) correctly sees
nothing. Every gate in `emitNotification` passes; the alert simply belongs to
someone else.

This is a test-data collision, not an app bug, and the two ways to clear it are
both outside the e2e suite:

- make the seeded names unique (re-seed with distinct names, or deactivate the
  stale duplicate accounts), or
- send the mentioned user's id alongside the text and stop resolving people by
  display name — a Chat protocol change, deliberately not attempted here.

Do not "fix" the spec by loosening the assertion. The test's whole claim is that
the alert reaches the teammate whose name was typed, and a DB where two people
share a name cannot show that.
