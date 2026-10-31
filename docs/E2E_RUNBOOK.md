# E2E Runbook

Playwright suite: 232 test declarations in `src/e2e/*.spec.ts`, multiplied across the
three device projects (`chromium`, `Mobile Chrome`, `Tablet`) plus two `auth.setup`
runs — **443 tests in total**. Every test runs against a **production build** of the app
served from an isolated dist directory, talking to the **`decoricks_test`** MongoDB
database only.

Read section 2 before you run anything. On a loaded machine this suite does not produce
a slower result, it produces a wrong one.

## 1. Prerequisites

- Node 18+ / 20+, npm
- Playwright browsers: `npx playwright install`
- An Atlas (or local) MongoDB reachable from `MONGODB_URI` in `.env.local`
- `.env.e2e.local` present (gitignored). It holds the e2e account identities and the
  test-database name.

## 2. Machine conditions — the part that decides whether the run means anything

Each browser context in this suite holds a live SSE `/api/events` stream, and the server
keeps an Atlas change-stream open per subscriber. On a single free-tier M0 instance that
is the binding constraint, which is why `playwright.config.ts` caps the default at 2
workers and says so in a comment. It is not a performance setting; it is a correctness
setting.

The full suite was recently observed to report **70 failures** under one set of
conditions and **0 failures on the same commits, same tests** under another. The
difference was the machine, not the code:

| condition             | runs that produced a verdict | run that produced noise       |
| --------------------- | ---------------------------- | ----------------------------- |
| workers               | 1 (`CI=1`)                   | 2 (the non-CI default)        |
| other `next dev`      | none anywhere on the machine | one idle, ~840 MB             |
| other `next start`    | only the suite's own server  | a stale one on port 3113      |
| 1-minute load average | 3.3 and 5.1                  | 2.9–9.4, 5-min average over 8 |
| swap free             | 302 MB and 1.4 GB            | ~70 MB of 10 GB               |

Two full runs at 1 worker came back clean — **357 passed, 0 failed, 0 flaky in 14.4
minutes** and **355 passed, 0 failed, 2 flaky in 20.5 minutes**. The run that produced 70
phantom failures used 2 workers, with two foreign Next servers alive.

Be careful reading that table: the variables that were _confounded_ in the bad run are
worker count and competing Next processes, and those are the ones worth treating as hard
rules. Load average and free swap were also worse, but a clean run started with only
302 MB of free swap — so neither number is a guarantee, and a calm-looking `uptime` is no
licence to raise the worker count. The two rules that are supported by the evidence:

- **run at 1 worker** (`CI=1`), and
- **run with no other `next dev` or `next start` alive on the machine** — including one
  belonging to a different project, which steals memory just as effectively.

If the machine is genuinely thrashing — swap nearly full and load climbing rather than
falling — wait before starting. The run is not faster for having started; it is just later
and wrong.

```bash
uptime                       # want load falling, not climbing
sysctl vm.swapusage
ps aux | grep -E 'next (dev|start)' | grep -v grep
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(3000|3111|3113|3201|3202|3203)'
```

The `ps` check must be empty apart from servers **you are about to start for this suite**.
The `lsof` check matters because the config uses `reuseExistingServer: false` in CI mode:
it will not steal a port, it will fail on it, and the failure looks like a test failure.

443 tests at 1 worker takes 15–25 minutes, plus the seed and the production build the
`webServer` block runs first. It is worth clearing the queue of heavy desktop work for
that window anyway — the flake that survived the 20.5-minute run above was a browser
dialog failing to open while chat tests were still holding server-side streams.

## 3. Environment variables

`.env.local` supplies the application side (`MONGODB_URI`, `SESSION_SECRET`, …) and is
read automatically by Next. `.env.e2e.local` is **not** read automatically — it is
written with `export` prefixes so it must be sourced in a shell:

```bash
set -a; . ./.env.local; . ./.env.e2e.local; set +a
```

`.env.e2e.local` carries exactly five variables:

| Variable            | Purpose                                                       |
| ------------------- | ------------------------------------------------------------- |
| `E2E_TEST_MODE`     | must be `1`; see below — it is what makes the DB switch legal |
| `MONGODB_TEST_DB`   | the database under test. Default `decoricks_test`.            |
| `E2E_FOUNDER_EMAIL` | Founder account for `auth.setup`                              |
| `E2E_AFNAN_EMAIL`   | Partner account for the second-device tests                   |
| `E2E_PASSWORD`      | the single password both accounts use                         |

Three rules that are easy to get wrong:

- **`MONGODB_TEST_DB` is refused unless the process is a test runner.**
  `src/lib/db-name.ts` throws `MONGODB_TEST_DB is set but the process is not a test
runner` unless `E2E_TEST_MODE=1` or `NODE_ENV=test`. Setting `MONGODB_TEST_DB` in a
  normal shell and then running `next dev` is therefore an error, not a config. Leave it
  to the suite.
- **Do not export `NODE_ENV=test` yourself.** `playwright.config.ts` pins
  `NODE_ENV: 'production'` for the webServer on purpose: the layout assertions only
  reproduce in the shipped bundle, and `next dev`/test-mode recompiles mask them.
  Playwright sets `NODE_ENV=test` on spawned processes by itself; the config overrides
  it. E2E mode comes from `E2E_TEST_MODE=1`, not from `NODE_ENV`.
- **Do not set `PLAYWRIGHT_BASE_URL` unless you mean to bypass everything.** When it is
  set, the managed `webServer` is switched off entirely (`manageServer` in the config) —
  no seed, no build, no server. Useful for a fast retry loop, and a trap if you forgot
  that the server you pointed at is an old build.

The seed reads `E2E_DB ?? MONGODB_TEST_DB ?? 'decoricks_test'`. Keep the two in step, or
the script will seed one database while the app reads another.

## 4. Safety guards, as they actually behave

`scripts/seed-e2e.ts` refuses to write unless two independent checks pass
(`assertTestTarget`):

1. The name must match the project's test shapes — `^decoricks_test$` or `^test_…`.
   **A bare `test` fails this on purpose.** In this deployment the Atlas URI has an
   empty path, so the driver falls back to `test`, and `test` holds real records.
2. The name must differ from the database the application resolves to once
   `MONGODB_TEST_DB` is removed — which catches a test-shaped name that was also
   configured as the application database.

Separately, `assertScriptDatabaseConsent` (`src/lib/db-name.ts`) blocks any writing
maintenance script from targeting a non-test-shaped database unless
`DECORICKS_ALLOW_PROD_DB=1` is set, and `decoricks_prod` is refused absolutely — there
is no override for it.

If a guard fires, believe it. It fired because it was written after something real was
nearly overwritten.

## 5. Quick check — under 10 minutes

Use after any change to auth, session/bootstrap, security guards, layout or navigation,
and before asking for a review. Measured: **64 tests, about 6 minutes** at 1 worker,
including the seed and the production build.

```bash
set -a; . ./.env.local; . ./.env.e2e.local; set +a
CI=1 npx playwright test \
  src/e2e/login-credential-url.spec.ts \
  src/e2e/phase2-auth.spec.ts \
  src/e2e/phase10-security.spec.ts \
  src/e2e/phase12-session-bootstrap.spec.ts \
  src/e2e/layout.spec.ts \
  --project=chromium --reporter=line
```

`CI=1` gives 1 worker, 2 retries and the line reporter. To iterate on one spec without
paying for a rebuild every time, start the server once and point at it — accepting that
you are then responsible for the server being current:

```bash
# one terminal
E2E_TEST_MODE=1 MONGODB_TEST_DB=decoricks_test NEXT_DIST_DIR=.next-e2e \
  npx tsx scripts/seed-e2e.ts && npx next build && npx next start -p 3111
# other terminal — no CI, so the existing server is reused
npx playwright test src/e2e/layout.spec.ts --project=chromium \
  --workers=1 --retries=2 --reporter=line
```

## 6. Pre-deploy check

Everything, in this order. Any single non-zero exit stops the deploy.

```bash
# 1. Confirm the machine conditions in section 2 first. Then:
npx tsc --noEmit
npm run lint
npm run test              # vitest, unit + integration
npm run format:check
CI=1 npx playwright test --reporter=line     # 443 tests, full suite, 1 worker
npm run build
```

Use `CI=1` and do not add `--workers`. A 2-worker full run is not "the same result,
faster"; on this backend it is a different, less trustworthy result — and it is not even
faster. Measured: **14.4 minutes at 1 worker (357 passed, 86 skipped, 0 failed, 0
flaky)** against **38.7 minutes at 2 workers reporting 70 failures that could not be
reproduced at any commit under 1-worker conditions.** Two browser contexts holding live
`/api/events` streams each cost the single free-tier M0 instance more than the parallelism
wins, so the "slower" setting is the one that finishes first _and_ tells the truth.

If you must compare commits, give each one its own worktree, port and dist directory so
they cannot contend:

```bash
git worktree add /tmp/dx-92 92b40a1
ln -s "$PWD/node_modules" /tmp/dx-92/node_modules
cp .env.local .env.e2e.local /tmp/dx-92/
cd /tmp/dx-92 && set -a && . ./.env.local && . ./.env.e2e.local && set +a
CI=1 E2E_PORT=3201 NEXT_DIST_DIR=.next-e2e-92 \
  npx playwright test src/e2e/phase12-session-bootstrap.spec.ts \
  --project=chromium --reporter=line
```

Remove the worktree and its env copies when you are done — they contain secrets:

```bash
git worktree remove --force /tmp/dx-92
```

### 6.1 Known side effects of running the suite

- **`next build` rewrites `tsconfig.json`.** It reformats the arrays and appends
  `<NEXT_DIST_DIR>/types/**/*.ts` to `include`. With the default `.next-e2e` that line
  is already committed, so the only diff is formatting; with a custom `NEXT_DIST_DIR`
  (`.next-e2e-head`, `.next-e2e-92`, …) a new path is added. Either way, restore it
  before `format:check` or a commit: `git checkout -- tsconfig.json`. Run the build
  first and the format check last, or the format check will fail on a file you did not
  touch.
- **Only `.next-e2e/` is gitignored.** A custom dist directory is **not**, so it shows up
  as untracked and can be committed by an indiscriminate `git add -A`. Delete it:
  `rm -rf .next-e2e-*`.
- **The HTML reporter keeps a process alive.** Without `CI=1` the reporter is `html`,
  which serves `playwright-report/` on port 9323 and does not exit when the run ends.
  That leftover process looks like a hung test run and holds the port. Use
  `--reporter=line` for anything script-driven, and kill the straggler if it is already
  up.
- `src/e2e/.auth/*.json` are regenerated by `auth.setup` on every run. They are
  gitignored; if they are missing the setup project recreates them.
- The seed does **not** reset the database unless you pass `--reset`, so e2e users and
  records accumulate between runs. `npm run cleanup:e2e` is a dry run,
  `npm run cleanup:e2e:apply` writes.

## 7. Classifying a failure

Do not accept "it's flaky" or "it's the environment" as an answer. The rule this project
uses: a failure is **environmental** only if the same test passes at the last known-green
commit _and_ at the commit under review, under identical conditions, and fails only when
the machine is under memory pressure. Anything else is a real regression until proven
otherwise.

`git bisect` is the tool, with one caveat worth checking first: if the suspects are
adjacent commits (`git rev-list --count A..B` returns 1) there is nothing to bisect — run
both and compare. That is exactly how the 70-failure reading above was resolved: the
range `92b40a1..00a20da` was one commit wide, and all 39 contested specs passed
first-time, with zero retries, at `92b40a1`, at `00a20da` and at HEAD under 1-worker
conditions.

- **Real** — fails deterministically at HEAD and passed at the earlier commit. Fix it,
  with a test, in a small commit.
- **Flaky** — fails once and passes on retry, repeatedly across runs. Note the spec,
  because a suite that needs retries to pass is telling you something about timeouts.
- **Environmental** — passes at every commit under 1 worker with a quiet machine and
  fails only under load. Fix the conditions, not the test.

Never fix a failure by weakening the assertion. `phase12-session-bootstrap.spec.ts`
asserts that an `/api/auth/me` 500 shows the retry state and that the page recovers
after Retry — the exact cold-start path of a free instance that sleeps between requests.
If that test is adjusted to pass, the guard it exists for has been deleted.

## 8. Known flakes and what they look like

Two specs are worth recognising on sight so they are not mistaken for regressions.

`profile-avatar.spec.ts:248` — "the picker opens from the keyboard, and cancelling
stores nothing" can hang on `page.waitForEvent('filechooser')` until the test timeout,
with `Test timeout … exceeded` and `Target page, context or browser has been closed`.
The test asserts `toBeFocused()` on the avatar button first, and that assertion passes in
every occurrence: focus is correct, Enter is delivered, the handler runs, and only the
native picker never surfaces. It reproduced twice in five runs when scheduled
immediately after `phase3-collab.spec.ts:169` (which leaves several contexts and their
Atlas change-streams behind), never in six runs on its own (0.8–1.6 s each), and raising
the timeout to 90 s did not help — a dialog that never opens is not a budget problem.
Treat it as browser-under-load, not a keyboard bug, and do not "fix" it by dropping the
focus assertion or padding the timeout.

`phase3-collab.spec.ts:169` — fails intermittently with
`apiRequestContext.get: read ECONNRESET` inside its `poll()` on
`/api/chat/channels/…/messages`. It passed 5 of 5 on a calm machine. The connection is
being dropped by the local server while it is busy, not by the app logic.

Both pass on the first retry. If either starts failing _deterministically_, that is a new
problem and the evidence above no longer applies.

## 9. Display names are lookup keys — the `phase3-collab` failure and its guard

`src/e2e/phase3-collab.spec.ts` — "a mention picked from the autocomplete persists,
alerts the teammate, and deep-links the room" used to fail on a test DB that held more
than one active user with the same display name, which is what `scripts/seed-e2e.ts`
left behind when it was run with different `E2E_FOUNDER_EMAIL` / `E2E_AFNAN_EMAIL`
values (the Oct 21 `@decoricks.com` pair and the Oct 25 `@decoricks.test` pair both
stayed active).

Why the name is the problem: the composer sends text, not an id, and `findMentions`
(`src/lib/chat-mentions.ts`) rebuilds identity by looking the display name up in a `Map`
that is filled in `_id` order — last write wins. So `@E2E Afnan` resolved to the newest
duplicate, `emitNotification` wrote the alert to that account, and device B (logged in as
the older one) correctly saw nothing. Every gate in `emitNotification` passed; the alert
simply belonged to someone else.

That is now prevented in the seed rather than in the spec: `retireDuplicateDisplayNames`
(commit `7aeb656`) deactivates every _other_ active account carrying the name it just
provisioned, and the seed prints what it retired so the change is never silent:

```text
Retired 1 other active account(s) named "E2E Afnan" (deactivated, rows kept): …
```

Deactivating rather than deleting is deliberate — `isActive: false` removes the account
from the directory, mention, notification and login paths while leaving its rows intact
for anything that still points at them (tasks assigned to it, messages it wrote), so
clearing the collision cannot itself invent dangling references.

If this test fails again, the duplicate got past the guard: re-run the seed and read the
`Retired …` lines, or `npx tsx scripts/seed-e2e.ts --reset` for a clean database. The
remaining fix is a Chat protocol change — send the mentioned user's id alongside the text
and stop resolving people by display name — and it is deliberately not attempted here.

Do not "fix" the spec by loosening the assertion. The test's whole claim is that the
alert reaches the teammate whose name was typed, and a DB where two people share a name
cannot show that.
