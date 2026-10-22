#!/bin/sh
# Boots the current production build against the isolated `decoricks_test`
# database on the e2e port. Read-only for the application database by design:
# E2E_TEST_MODE + MONGODB_TEST_DB make src/lib/mongodb.ts resolve the test DB.
cd "$(dirname "$0")/.."
export NODE_ENV=production
export E2E_TEST_MODE=1
export MONGODB_TEST_DB="${MONGODB_TEST_DB:-decoricks_test}"
exec npx next start -p "${PORT:-3111}"
