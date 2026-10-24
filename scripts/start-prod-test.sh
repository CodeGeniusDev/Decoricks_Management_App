#!/bin/sh
# Boots the current production build against the isolated `decoricks_test`
# database on the e2e port. Read-only for the application database by design:
# E2E_TEST_MODE + MONGODB_TEST_DB make src/lib/mongodb.ts resolve the test DB.
#
# NEXT_DIST_DIR is the other half of that isolation: the build lands in
# .next-e2e instead of .next, so building or starting this server cannot delete
# the chunks a `next dev` running at the same time is serving. Build with the
# same value or this starts an older tree:
#   NEXT_DIST_DIR=.next-e2e npx next build && scripts/start-prod-test.sh
cd "$(dirname "$0")/.."
export NODE_ENV=production
export E2E_TEST_MODE=1
export MONGODB_TEST_DB="${MONGODB_TEST_DB:-decoricks_test}"
export NEXT_DIST_DIR="${NEXT_DIST_DIR:-.next-e2e}"
exec npx next start -p "${PORT:-3111}"
