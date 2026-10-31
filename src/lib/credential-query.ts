/**
 * Credentials do not belong in a URL.
 *
 * A URL is copied, pasted, bookmarked, kept in browser history, sent as a
 * `Referer` header to every asset the page loads, written into the access log of
 * every proxy between the browser and this app, and typed straight back into the
 * address bar tomorrow by the person who "just wanted to save the page". A
 * password in one is exposed to all of that and cannot be recalled from any of
 * it. The login form's native pre-hydration submit proved the path was live
 * (`/login?email=…&password=…`), so the rule is enforced on the way in as well as
 * fixed at the source.
 *
 * This module is deliberately pure and free of `next/server` imports: it runs in
 * the edge middleware bundle, in Node route handlers, in the audit writer, and in
 * plain unit tests. Nothing in it can throw on a malformed value, because it is
 * called from a request path where a crash would be worse than a leak.
 *
 * The invariant that matters for every function here: **names are safe, values
 * are not**. Detection returns key names so an operator can see what went wrong;
 * it never returns or echoes a value.
 */

/**
 * Query-string keys that name a secret. Matched on the normalised form (lower
 * case, separators removed), so `password`, `Password`, `PASSWORD`, `new_password`
 * and `new-password` all land here.
 *
 * Wider than the password fields alone on purpose. A `?token=` or `?apiKey=` in a
 * URL is the same class of mistake — a bearer value in a place that is copied
 * about — and this app hands out session and CSRF values that must never travel
 * in a query string. Deliberately NOT wider still: no generic word that an
 * ordinary filter could legitimately use (`q`, `search`, `code`, `key` alone,
 * `from`, `to`, `page`), because refusing a legitimate request is its own failure
 * and every API route in the app is free to add query parameters tomorrow.
 */
const CREDENTIAL_QUERY_KEYS: ReadonlySet<string> = new Set([
  // The password family, including the names the change-password form uses.
  'password',
  'passwd',
  'pass',
  'pwd',
  'currentpassword',
  'newpassword',
  'confirmpassword',
  'oldpassword',
  'repassword',
  'passwordrepeat',
  'passwordconfirm',
  'passwordhash',
  'passwordresettoken',
  // Bearer values that a URL has no business carrying.
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'sessiontoken',
  'csrftoken',
  'tokenhash',
  'authorization',
  'cookie',
  'session',
  'sessionid',
  'secret',
  'apisecret',
  'clientsecret',
  'appsecret',
  'apikey',
  'privatekey',
  'otp',
])

/** Lower-cases a key and drops the separators that only exist for readability. */
export const normalizeQueryKey = (key: string): string =>
  key.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Is this query-string key one whose value is a secret? */
export const isCredentialKey = (key: string): boolean =>
  CREDENTIAL_QUERY_KEYS.has(normalizeQueryKey(key))

const toSearchParams = (params: URLSearchParams | string): URLSearchParams =>
  typeof params === 'string' ? new URLSearchParams(params) : params

/**
 * Which credential-named keys a query string carries — the names only.
 *
 * Deduplicated on the normalised key but reported in the spelling the caller used,
 * so a log line says `currentPassword` and not a lowercase guess. Returns an empty
 * array for anything without a secret name, which is the overwhelmingly common
 * case and the reason this is cheap enough to run on every request.
 */
export const findCredentialKeys = (params: URLSearchParams | string): string[] => {
  const found: string[] = []
  const seen = new Set<string>()
  for (const key of toSearchParams(params).keys()) {
    const normalized = normalizeQueryKey(key)
    if (!CREDENTIAL_QUERY_KEYS.has(normalized) || seen.has(normalized)) continue
    seen.add(normalized)
    found.push(key)
  }
  return found
}

export const hasCredentialParams = (params: URLSearchParams | string): boolean =>
  findCredentialKeys(params).length > 0

/**
 * A copy of `params` with every credential-named entry removed.
 *
 * Everything else survives unchanged — including `next`, which is how a redirect
 * out of a tainted URL can still return the visitor to where they were going, and
 * including repeated keys, so a legitimate multi-value filter is never quietly
 * collapsed. The input is never mutated: `URLSearchParams` on a `NextURL` is the
 * request's own object.
 */
export const stripCredentialParams = (
  params: URLSearchParams | string
): { params: URLSearchParams; removed: string[] } => {
  const source = toSearchParams(params)
  const kept = new URLSearchParams()
  const removed = findCredentialKeys(source)
  for (const [key, value] of source.entries()) {
    if (!isCredentialKey(key)) kept.append(key, value)
  }
  return { params: kept, removed }
}

/**
 * Redacts secret-looking `key=value` / `key: value` pairs from free text.
 *
 * For log lines, error messages and audit `details` — the places where a URL gets
 * quoted by something that was never written to know what a URL contains. A Mongo
 * error, a `fetch` failure or an upstream response body can all carry the request
 * line they choked on, and the value in it is the operator's password.
 *
 * Deliberately name-driven rather than pattern-driven: guessing what a password
 * "looks like" redacts the wrong things. `password=[redacted]` keeps the shape of
 * the line — which is what makes a log readable — and loses only the value.
 *
 * Two things about the shape are easy to get wrong and are covered by tests:
 *
 *   - `?` ENDS a value. If it does not, a harmless key swallows the rest of the URL
 *     as its own value and the scan resumes past the leak: in
 *     `GET http://host/login?password=x` the value of `http` would become
 *     `//host/login?password=x`, `http` is not on the list, and the function would
 *     return the secret untouched. Stopping at `?` lets the next pair be seen.
 *   - `/` does NOT end a value, so a path-shaped secret (`password=/tmp/x`) is
 *     covered whole.
 */
const SECRET_PAIR = /([A-Za-z0-9_-]{1,64})("?)(%3D|[=:])\s*("?)([^"&?\s,;}']*)/gi

/**
 * `scheme://user:password@host` — credentials in the authority of a URL rather than
 * in its query string, which the name-driven rule above cannot see because no key
 * named `password` appears in the text. This is the shape a database driver echoes
 * when it fails to connect, and it is the single most valuable secret in this app's
 * environment. The match starts at `//`, which is why the replacement repeats the
 * slashes and adds no colon of its own — the scheme's colon sits outside the match.
 */
const URL_USERINFO = /\/\/([^/\s@]+):([^/\s@]+)@/g

export const scrubCredentials = (text: string): string => {
  if (!text || (!text.includes('=') && !text.includes(':') && !text.includes('%3D'))) return text
  const withoutPairs = text.replace(
    SECRET_PAIR,
    (match, key: string, keyQuote: string, separator: string, valueQuote: string) =>
      // Only the value is replaced; the key, the separator and any quoting stay
      // exactly as they were, so the line is still recognisable to whoever reads
      // it. The `keyQuote` group exists because JSON writes `"password": "x"` —
      // the closing quote sits between the key and the colon, and without it the
      // most common machine-generated log shape would slip past the redaction.
      isCredentialKey(key)
        ? `${key}${keyQuote}${separator}${valueQuote}[redacted]${valueQuote}`
        : match
  )
  return withoutPairs.replace(URL_USERINFO, '//[redacted]@')
}

/**
 * The path an operator should see for a request URL: the pathname, and nothing
 * else. The query string is dropped rather than scrubbed here, because a route
 * label never needs a parameter and "drop the whole thing" cannot miss a key that
 * a future rename invents.
 *
 * The remaining text is scrubbed too. Almost anything parses as a URL relative to
 * a base — `password=hunter2` resolves to the path `/password=hunter2` rather than
 * throwing — so a caller handing over a fragment instead of a URL would otherwise
 * get its secret back out of the "safe" helper.
 */
export const safeLogPath = (url: string): string => {
  let path = url
  try {
    path = new URL(url, 'http://localhost').pathname
  } catch {
    // Not resolvable at all; keep the text and let the redaction handle it.
  }
  return scrubCredentials(path)
}
