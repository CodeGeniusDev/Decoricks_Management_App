/**
 * Phase 5 §2 audit instrument: per-route security-control coverage.
 *
 * Reads every `src/app/api/**\/route.ts`, extracts the exported HTTP handlers,
 * and records which controls are reachable from each. It is a *scanner over
 * source text*, not a runtime probe: it can show that a handler carries no
 * visible guard (review needed), it cannot prove a guard is executed. Everything
 * it flags is checked by hand or by an HTTP test before being treated as a
 * finding — that is what the two-phase pass below is for.
 *
 * Control vocabulary is the app's real one, not a generic guess:
 *   guard       — authorize() / requireAuth() / requireFounder() / withAuth()
 *                 / getAuthenticatedUser() / assertCsrf()
 *   validation  — a zod schema `.parse()` / `.safeParse()`
 *   audit       — recordAuditEntry()
 *   retry       — withMongoRetry() (transient-outage retry)
 *
 * The subtlety this handles: most routes here put the guard in a file-local
 * helper (`loadNotifications`, `savePreferences`, …) that the exported handler
 * merely invokes, so a handler's range is grown transitively over the file-local
 * functions it names. Judging only the text between one `export` and the next
 * mislabels 14 perfectly guarded handlers as unguarded.
 *
 * Usage: node scripts/route-audit.mjs [--json]
 */
import fs from 'node:fs'
import path from 'node:path'

const API_ROOT = path.join(process.cwd(), 'src/app/api')
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])

const CONTROLS = {
  guard:
    /\b(?:authorize|requireAuth|requireFounder|withAuth|getAuthenticatedUser|assertCsrf)\s*\(/g,
  // Any `.parse(...)` / `.safeParse(...)`: inline `z.object({...}).parse(body)` is
  // as valid as a named schema, and the braces in the former defeat a
  // `\w+\.parse` pattern.
  validation: /\.\s*(?:parse|safeParse)\s*\(/g,
  audit: /\brecordAuditEntry\s*\(/g,
  retry: /\bwithMongoRetry\s*\(/g,
}

/**
 * Source range of a file-local helper, in either of the two forms this codebase
 * uses: `function name(...)` and `const name = async (...) => ...`.
 */
function functionRange(src, name) {
  const escaped = name.replace(/\$/g, '\\$')
  const patterns = [
    new RegExp(`(?:^|\\n)(?:async\\s+)?function\\s+${escaped}\\s*\\(`),
    new RegExp(
      `(?:^|\\n)const\\s+${escaped}\\s*=\\s*(?:async\\s*)?(?:\\(|[A-Za-z_$][\\w$]*\\s*=>)`
    ),
  ]
  let at = -1
  let head = ''
  for (const p of patterns) {
    const m = src.match(p)
    if (m && m.index !== undefined) {
      at = m.index + (src[m.index] === '\n' ? 1 : 0)
      head = m[0]
      break
    }
  }
  if (at === -1) return ''
  // Locate the body brace by walking the parameter list first.
  //
  // Naively taking the first `{` after the header lands inside a *type* —
  // `context: { params: Promise<{ id: string }> }` — and the brace walk then
  // closes before the function body, hiding the guard inside it.
  const openParen = src.slice(at).indexOf('(')
  if (openParen === -1) return ''
  let p = at + openParen
  let pDepth = 0
  while (p < src.length) {
    const c = src[p]
    if (c === '(') pDepth++
    else if (c === ')') {
      pDepth--
      if (pDepth === 0) break
    }
    p++
  }
  const brace = src.slice(p).search(/\{/)
  if (brace === -1) return ''
  let i = p + brace
  let depth = 0
  const start = i
  while (i < src.length) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return src.slice(at, i + 1)
    }
    i++
  }
  return src.slice(at, Math.min(start + 4000, src.length))
}

/** Every file-local helper name, in either declaration form. */
function topLevelFunctions(src) {
  const fn = [...src.matchAll(/(?:^|\n)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(
    (m) => m[1]
  )
  const constFn = [
    ...src.matchAll(
      /(?:^|\n)const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|[A-Za-z_$][\w$]*\s*=>)/g
    ),
  ].map((m) => m[1])
  return [...new Set([...fn, ...constFn])]
}

/**
 * The exported handler's own range: from its `export` to the next top-level
 * `export`, plus the transitive closure of file-local functions it calls.
 */
function handlerRange(src, method) {
  const patterns = [
    new RegExp(`(?:^|\\n)export\\s+const\\s+${method}\\s*=`),
    new RegExp(`(?:^|\\n)export\\s+(?:async\\s+)?function\\s+${method}\\s*\\(`),
  ]
  let at = -1
  for (const p of patterns) {
    const m = src.match(p)
    if (m && m.index !== undefined) {
      at = src.slice(m.index).search(/\S/) + m.index
      break
    }
  }
  if (at === -1) return null

  const rest = src.slice(at + 1)
  const nextExport = rest.search(/\nexport\s(?:const|async\s+function|function|\{)/)
  let body = nextExport === -1 ? src.slice(at) : src.slice(at, at + 1 + nextExport)

  // Grow over named file-local helpers, transitively (bounded depth 5).
  //
  // Reference by NAME, not by call: this codebase's handlers are
  // `export const GET = withAuth(__GET)` — the helper is passed as a value, so a
  // `name(` pattern would never see it and every such route would look unguarded.
  const names = topLevelFunctions(src)
  for (let pass = 0; pass < 5; pass++) {
    let grew = false
    for (const n of names) {
      if (
        new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\b`).test(body) &&
        !body.includes(functionRange(src, n))
      ) {
        const range = functionRange(src, n)
        if (range) {
          body += '\n' + range
          grew = true
        }
      }
    }
    if (!grew) break
  }
  return body
}

/** `export { GET } from './x'` inherits x's controls, so resolve it. */
function reexportedBody(src, file) {
  const stmts = src.match(/export\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]/g) || []
  const bodies = []
  for (const stmt of stmts) {
    const spec = stmt.match(/from\s*['"]([^'"]+)['"]/)[1]
    const base = path.resolve(path.dirname(file), spec)
    for (const cand of [base + '.ts', path.join(base, 'route.ts')]) {
      if (fs.existsSync(cand)) bodies.push(fs.readFileSync(cand, 'utf8'))
    }
  }
  return bodies.join('\n')
}

const has = (control, text) => {
  if (!text) return false
  CONTROLS[control].lastIndex = 0
  return CONTROLS[control].test(text)
}

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p) : e.name === 'route.ts' ? [p] : []
  })

const rows = []
for (const file of walk(API_ROOT)) {
  const src = fs.readFileSync(file, 'utf8')
  const rel = path
    .relative(process.cwd(), file)
    .replace(/^src\/app\//, '')
    .replace(/\/route\.ts$/, '')
  const carried = reexportedBody(src, file)
  for (const method of METHODS) {
    const own = handlerRange(src, method)
    if (own === null) continue
    // A handler aliased to a shared rejecter (`export const PUT = methodNotAllowed`)
    // has no body to guard: it is a 405 by construction.
    const rejected = own.length < 160 && /methodNotAllowed|notAllowed/.test(own)
    const text = own + (carried ? '\n' + carried : '')
    rows.push({
      route: rel,
      method,
      guarded: has('guard', text),
      rejected: rejected && !has('guard', own.replace(/methodNotAllowed/g, '')),
      validation: has('validation', text),
      audit: has('audit', text),
      retry: has('retry', text),
      mutating: !SAFE.has(method),
    })
  }
}

const unguarded = rows.filter((r) => !r.guarded && !r.rejected)
const noValidation = rows.filter((r) => r.mutating && !r.validation && !r.rejected)
const noAudit = rows.filter((r) => r.mutating && !r.audit && !r.rejected)

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify({ total: rows.length, rows }, null, 2) + '\n')
} else {
  const table = (label, list) => {
    console.log(`\n### ${label} (${list.length})`)
    for (const r of list) console.log(`  ${r.method.padEnd(6)} /${r.route}`)
  }
  console.log(
    `Handlers scanned: ${rows.length} · guarded ${rows.filter((r) => r.guarded).length} · ` +
      `explicitly rejected (405) ${rows.filter((r) => r.rejected).length}`
  )
  table('NO reachable auth guard — review each', unguarded)
  table('Mutating, no reachable zod validation — review each', noValidation)
  table('Mutating, no audit write — review each', noAudit)
}
