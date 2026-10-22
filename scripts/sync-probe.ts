/**
 * Change-stream propagation probe (Phase 5 §3/§6 evidence).
 *
 * The browser test can only observe "the row appeared". This answers the
 * narrower question the whole realtime design rests on: does a write performed
 * over HTTP actually produce a `change` frame on an open `/api/events` stream,
 * i.e. is `db.watch()` alive on this host — or does the stream merely carry the
 * connect-time baseline and then go quiet?
 *
 * Reads nothing but the stream and one product write; the write is namespaced
 * with a unique SKU so it can be recognised in the log.
 *
 * Usage: npx tsx scripts/sync-probe.ts [module] [path-to-storage-state]
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const loadEnvLocal = (): void => {
  const file = path.join(process.cwd(), '.env.local')
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!match) continue
    const value = match[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
    if (process.env[match[1]] === undefined) process.env[match[1]] = value
  }
}
loadEnvLocal()

const BASE = `http://localhost:${Number(process.env.E2E_PORT ?? 3111)}`
const MODULE = process.argv[2] ?? 'inventory'
const STATE = process.argv[3] ?? path.join('src', 'e2e', '.auth', 'founder.json')

const cookie = (): string => {
  const state = JSON.parse(readFileSync(STATE, 'utf8')) as {
    cookies?: Array<{ name: string; value: string }>
  }
  return (state.cookies ?? []).map((c) => `${c.name}=${c.value}`).join('; ')
}
const csrf = (): string => {
  const state = JSON.parse(readFileSync(STATE, 'utf8')) as {
    cookies?: Array<{ name: string; value: string }>
  }
  return state.cookies?.find((c) => c.name === 'decoricks_csrf')?.value ?? ''
}

const WATCH_FOR: Record<string, { label: string; run: () => Promise<string> }> = {
  inventory: {
    label: 'POST /api/products',
    run: async () => {
      const sku = `PROBE-${Date.now().toString(36)}`
      const res = await fetch(`${BASE}/api/products`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookie(), 'x-csrf-token': csrf() },
        body: JSON.stringify({
          sku,
          name: `Probe product ${sku}`,
          category: 'Accessories',
          cost: 1000,
          sellingPrice: 2000,
        }),
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`write failed ${res.status}: ${text.slice(0, 200)}`)
      return sku
    },
  },
  tasks: {
    label: 'POST /api/tasks',
    run: async () => {
      const title = `PROBE-${Date.now().toString(36)}`
      const res = await fetch(`${BASE}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookie(), 'x-csrf-token': csrf() },
        body: JSON.stringify({ title }),
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`write failed ${res.status}: ${text.slice(0, 200)}`)
      return title
    },
  },
}

async function main(): Promise<void> {
  if (!existsSync(STATE)) throw new Error(`no storage state at ${STATE} — run the auth setup first`)
  const watch = WATCH_FOR[MODULE]
  if (!watch) throw new Error(`unsupported module "${MODULE}" (keys: ${Object.keys(WATCH_FOR)})`)

  console.log(`${BASE}/api/events as the saved session, watching module "${MODULE}"`)
  const res = await fetch(`${BASE}/api/events?modules=${MODULE}`, {
    headers: { cookie: cookie(), accept: 'text/event-stream' },
  })
  if (!res.ok || !res.body) throw new Error(`stream refused: HTTP ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const frames: Array<{ ms: number; event: string; data: string }> = []
  let streamClosed = false
  let readerError = ''

  // A single, continuous consumer for the whole lifetime of the stream. There
  // is deliberately no "wait window" here: a window that closes while a read is
  // in flight abandons that promise, and the next window's fresh `read()` is a
  // second concurrent read on the same reader — so the stream hands the chunk
  // to the abandoned promise and it is thrown away. Two earlier versions of
  // this probe reported "no change frame" for a signal the server had
  // demonstrably enqueued precisely because of that, and the heartbeat looked
  // like proof the transport was fine while the real frame had been swallowed.
  const consume = async (): Promise<void> => {
    const t0 = Date.now()
    let buffer = ''
    // One outstanding read at a time, adopted across loop iterations.
    let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null
    try {
      for (;;) {
        pending ??= reader.read()
        const outcome = await pending
        pending = null
        if (outcome.done) {
          streamClosed = true
          console.log(`  +${String(Date.now() - t0).padStart(6)}ms  <stream closed by server>`)
          return
        }
        buffer += decoder.decode(outcome.value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? '' // a frame may straddle two chunks
        for (const raw of parts) {
          const event = /event: (\w+)/.exec(raw)?.[1]
          const data = /data: (.+)/.exec(raw)?.[1] ?? ''
          // Comment frames (`: ping`) carry no `event:` line; keep them visible
          // as transport liveness evidence.
          const name = event ?? `:${raw.slice(0, 12)}`
          console.log(`  +${String(Date.now() - t0).padStart(6)}ms  ${name}  ${data.slice(0, 120)}`)
          if (event) frames.push({ ms: Date.now() - t0, event, data })
        }
      }
    } catch (error) {
      readerError = (error as Error).message
    }
  }
  const consuming = consume()

  const hasChangeFor = (module: string): boolean =>
    frames.some((f) => f.event === 'change' && f.data.includes(module))

  const waitFor = async (ms: number, predicate: () => boolean): Promise<boolean> => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (predicate()) return true
      await new Promise((r) => setTimeout(r, 100))
    }
    return predicate()
  }

  await waitFor(4000, () => frames.some((f) => f.event === 'cursor'))
  const label = `${watch.label} → "${MODULE}" change frame`
  if (!frames.some((f) => f.event === 'cursor')) {
    console.log(`  (no baseline cursor frame arrived at all — the stream is inert)`)
  }

  console.log(`\n-- performing one write: ${label} --`)
  const tag = await watch.run()
  console.log(`  write accepted (${tag}), waiting 25s for the signal`)
  // 25s > the 20s heartbeat, so a missing `change` frame can be told apart from
  // a stream that has stopped delivering anything at all.
  const live = await waitFor(25_000, () => hasChangeFor(MODULE) || streamClosed)

  void reader.cancel()
  await consuming
  console.log(
    live && hasChangeFor(MODULE)
      ? `\nVERDICT: change stream is LIVE — the signal reached the open stream.`
      : streamClosed
        ? `\nVERDICT: the server CLOSED the stream before any change signal arrived.`
        : readerError
          ? `\nVERDICT: reader errored: ${readerError}`
          : `\nVERDICT: NO change frame for "${MODULE}" within 25s — the SSE stream carries only the` +
            ` connect-time baseline, so "Live" in the UI is not proof of live signals and any client` +
            ` that stands its poll down on a stream frame will stop updating.`
  )
  process.exit(live && hasChangeFor(MODULE) ? 0 : 2)
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
