// Browser-free runtime verification of cross-device realtime sync.
// Exercises the REAL running server + REAL authorization + REAL MongoDB, using
// two independent authenticated sessions (separate cookie jars = separate
// "devices"). Used because Chromium cannot launch in this sandbox.
const BASE = process.env.VERIFY_BASE || 'http://localhost:3222'
const PASSWORD = process.env.E2E_PASSWORD || 'Decoricks2026'

let failures = 0
const ok = (label) => console.log(`  PASS  ${label}`)
const bad = (label, detail) => {
  failures++
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
}
const assert = (cond, label, detail) => (cond ? ok(label) : bad(label, detail))

const jar = () => ({ session: '', csrf: '' })

async function send(path, { method = 'GET', body, cookies } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (cookies?.session) headers.cookie = `decoricks_session=${cookies.session}`
  if (cookies?.csrf)
    headers.cookie += (headers.cookie ? '; ' : '') + `decoricks_csrf=${cookies.csrf}`
  // Mirror the client: mutations echo the CSRF cookie value in the header.
  if (method !== 'GET' && cookies?.csrf) headers['x-csrf-token'] = cookies.csrf
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const setCookies =
    typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  return { res, setCookies, json: () => res.json().catch(() => null) }
}

async function login(email) {
  const { res, setCookies } = await send('/api/auth/login', {
    method: 'POST',
    body: { email, password: PASSWORD },
  })
  const c = jar()
  for (const raw of setCookies) {
    const [pair] = raw.split(';')
    const [k, v] = pair.split('=')
    if (k === 'decoricks_session') c.session = v
    if (k === 'decoricks_csrf') c.csrf = v
  }
  if (!c.session) throw new Error(`login failed for ${email}: ${res.status}`)
  return c
}

const tasksCursor = async (cookies) => {
  const { res, json } = await send('/api/sync/cursor?modules=tasks', { cookies })
  if (!res.ok) throw new Error(`cursor poll ${res.status}`)
  return (await json()).data.tasks
}

;(async () => {
  console.log(`\nRealtime cross-device verification @ ${BASE} (isolated test DB)\n`)

  const deviceA = await login('abdullah@decoricks.com') // Founder — writes
  const deviceB = await login('afnan@decoricks.com') // Partner — separate session/device
  ok('two independent authenticated sessions established')

  console.log('\n[1] Poll endpoint is auth-gated')
  const anon = await send('/api/sync/cursor?modules=tasks,finance')
  const anonBody = await anon.json()
  assert(anon.res.status === 401, 'anonymous poll returns 401', `got ${anon.res.status}`)
  assert(!anonBody?.data, 'anonymous poll leaks no cursor data')

  console.log('\n[2] Per-module authorization + input hardening (Partner session)')
  const scope = await send('/api/sync/cursor?modules=tasks,finance,not_a_module', {
    cookies: deviceB,
  })
  const scopeBody = await scope.json()
  assert(scope.res.status === 200, 'partner poll is 200')
  assert(typeof scopeBody.data.tasks === 'number', 'permitted module "tasks" returned as a number')
  assert(
    typeof scopeBody.data.finance === 'number',
    'permitted module "finance" returned as a number'
  )
  assert(scopeBody.data.not_a_module === undefined, 'unknown module is dropped, not leaked/500')

  console.log('\n[3] A write by device A advances the cursor device B observes')
  const before = await tasksCursor(deviceB)
  const boardRes = await send('/api/boards', {
    method: 'POST',
    body: { name: `Verify Board ${Date.now()}` },
    cookies: deviceA,
  })
  assert(boardRes.res.status === 201, 'founder board create is 201', `got ${boardRes.res.status}`)
  const board = (await boardRes.json()).data
  const detail = await send(`/api/boards/${board._id}`, { cookies: deviceA })
  const columnId = (await detail.json()).data.columns[0]._id

  const title = `Verified Remote Card ${Date.now()}`
  const taskRes = await send('/api/tasks', {
    method: 'POST',
    body: { boardId: board._id, columnId, title },
    cookies: deviceA,
  })
  assert(taskRes.res.status === 201, 'founder task create is 201', `got ${taskRes.res.status}`)

  let after = before
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    after = await tasksCursor(deviceB)
    if (after > before) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  assert(
    after > before,
    `device B cursor advanced after A's write (${before} -> ${after})`,
    `stuck at ${after}`
  )

  console.log('\n[4] The propagated change is the SAME persisted record (not just a timestamp)')
  const readBack = await send(`/api/tasks?boardId=${board._id}`, { cookies: deviceB })
  const readBody = await readBack.json()
  const found = readBody?.data?.tasks?.find((t) => t.title === title)
  assert(!!found, 'device B reads the exact task device A created from MongoDB')

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}\n`)
  await send('/api/boards/' + board._id, {
    method: 'PATCH',
    body: { isActive: false },
    cookies: deviceA,
  }).catch(() => {})
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => {
  console.error('\nVerification aborted:', e.message)
  process.exit(2)
})
