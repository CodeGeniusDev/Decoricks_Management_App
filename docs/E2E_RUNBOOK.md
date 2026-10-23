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
