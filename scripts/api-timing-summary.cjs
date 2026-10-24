#!/usr/bin/env node
/**
 * Phase 6 §4.1 — turns the `[api-timing]` lines a server started with
 * `API_TIMING=1` writes into per-endpoint and per-stage numbers.
 *
 * The emitter is `report()` in `src/lib/timing.ts:104-117`. Shape:
 *
 *   [api-timing] #12 GET /api/budgets total=371ms db:acquire=1ms x3 auth:session=62ms auth:role=63ms
 *                  ^id  ^label         ^wall      ^stage=ms [x<hits>] …
 *
 * Two things that are easy to misread, both decided by reading the emitter:
 *
 *  • `x3` belongs to the stage *before* it (`timing.ts:109`), so
 *    `db:acquire=1ms x3` is three pool acquisitions costing 1 ms all together.
 *    Acquire cost near zero with a high hit count means the pool is warm and the
 *    database is not the bottleneck — the numbered stages after it are.
 *  • Stages are a *subset* of `total` (`timing.ts:111-112`). The remainder is
 *    framework and un-instrumented work, so a stage list that sums well under
 *    the total is a measurement gap, not a contradiction.
 *
 * Stages are recorded in completion order, so a parallel group looks
 * interleaved; that is also how a serial chain gives itself away — every stage
 * sitting at the Atlas round-trip floor and the total equal to their sum.
 *
 * One log file per measurement run, so a before/after pair stays honest:
 *   node scripts/api-timing-summary.cjs /tmp/prod-before.log /tmp/prod-after.log
 */
const fs = require('node:fs')

const LINE = /^\[api-timing\] #\d+ ([A-Z]+) (\S+) total=(\d+)ms(.*)$/
// `name=12ms`, optionally followed by ` x4`. Names carry colons (`q:ledger:all`).
const STAGE = /(\S+?)=(\d+)ms(?: x(\d+))?/g

const median = (sorted) => sorted[Math.floor((sorted.length - 1) / 2)]
const percentile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: node scripts/api-timing-summary.cjs <logfile> [...]')
  process.exit(1)
}

for (const file of files) {
  /** key → { totals, acquires, stages: Map<name, ms[]> } */
  const endpoints = new Map()
  const errors = []
  let parsed = 0

  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!raw.includes('[api-timing]')) continue
    const m = LINE.exec(raw.trim())
    if (!m) {
      errors.push(raw.trim().slice(0, 160))
      continue
    }
    parsed += 1
    const [, method, path, total, rest] = m
    const bucket = endpoints.get(`${method} ${path}`) ?? {
      totals: [],
      acquires: [],
      stages: new Map(),
    }
    bucket.totals.push(Number(total))
    for (const s of rest.matchAll(STAGE)) {
      const [, name, ms, hits = '1'] = s
      const list = bucket.stages.get(name) ?? []
      for (let i = 0; i < Number(hits); i++) list.push(Number(ms) / Number(hits))
      bucket.stages.set(name, list)
      if (name === 'db:acquire') for (let i = 0; i < Number(hits); i++) bucket.acquires.push(1)
    }
    endpoints.set(`${method} ${path}`, bucket)
  }

  const rows = [...endpoints.entries()]
    .map(([key, b]) => {
      const totals = b.totals.slice().sort((x, y) => x - y)
      const stageMedians = [...b.stages.entries()]
        .map(([name, list]) => [name, median(list.slice().sort((x, y) => x - y))])
        .sort((a, c) => c[1] - a[1])
      return {
        key,
        n: totals.length,
        med: median(totals),
        p95: percentile(totals, 95),
        max: totals[totals.length - 1],
        hops: b.acquires.length,
        slowest: stageMedians[0] ? `${stageMedians[0][0]}=${stageMedians[0][1]}ms` : '—',
      }
    })
    .sort((a, b) => b.med - a.med)

  console.log(`\n### ${file} — ${parsed} timed requests, ${rows.length} distinct endpoints`)
  if (errors.length) console.log(`    ${errors.length} line(s) did not parse, e.g. ${errors[0]}`)
  console.log(
    '\nendpoint                             n  median    p95    max  db-hops  slowest stage (median)'
  )
  for (const r of rows) {
    console.log(
      `${r.key.padEnd(35)}${String(r.n).padStart(4)} ${String(r.med).padStart(6)}ms ${String(
        r.p95
      ).padStart(6)}ms ${String(r.max).padStart(5)}ms ${String(r.hops).padStart(8)}  ${r.slowest}`
    )
  }
}
