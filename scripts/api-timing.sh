#!/bin/sh
# Phase 6 §4.1 — server-side latency attribution.
#
# Isolates the cost the *server* pays per endpoint: session lookup, pool
# acquisition, query stages and serialisation. No browser and no Playwright are
# involved, so the machine's ambient load cannot inflate a "skeleton" number the
# way it can in nav-probe / perf-probe. Three calls per endpoint: the first
# usually includes a fresh Atlas connection, the following two are the warm pool.
#
# Pair this with the `[api-timing]` lines the same server writes when it is
# started with API_TIMING=1 — those break each call into its stages.
#
#   E2E_TEST_MODE=1 MONGODB_TEST_DB=… API_TIMING=1 sh scripts/start-prod-test.sh
#   sh scripts/api-timing.sh
#
# The status code is printed with every timing on purpose. An invented path
# answers 404 in about 3ms and looks like the fastest endpoint on the app.
BASE=http://localhost:3111
JAR=/tmp/probe-cookies.txt
EMAIL=${E2E_FOUNDER_EMAIL:-}
PASSWORD=${E2E_PASSWORD:-}

curl -s -c "$JAR" -o /dev/null -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"

for path in \
  /api/auth/me \
  /api/dashboard \
  "/api/sync/cursor?modules=tasks,chat,sales,inventory,finance,notifications" \
  /api/finance/settings \
  /api/finance/accounts \
  /api/finance/categories \
  /api/finance/partners \
  /api/finance/overview \
  "/api/finance/transactions?page=1&limit=25" \
  /api/dashboard/summary \
  "/api/notifications?limit=20" \
  "/api/stock/summary?includeArchived=true" \
  "/api/products?limit=25" \
  "/api/tasks?includeArchived=false" \
  "/api/boards" \
  /api/orders \
  /api/suppliers
do
  printf '%-46s' "$path"
  i=0
  while [ "$i" -lt 3 ]; do
    curl -s -b "$JAR" -o /dev/null -w '%{http_code}@%{time_total}s ' "$BASE$path"
    i=$((i + 1))
  done
  echo
done
