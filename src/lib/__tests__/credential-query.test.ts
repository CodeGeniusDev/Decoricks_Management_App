/**
 * The credential-in-URL rule, as a pure function.
 *
 * `src/middleware.ts` decides WHAT to do when a secret shows up in a query string
 * (redirect, or 400 for JSON); this module decides WHETHER it showed up at all,
 * and what the safe version of the URL and of a log line look like. That decision
 * is the part with the sharp edges, so it is tested on its own, with no HTTP
 * involved:
 *
 *   1. A leaked value is never returned, echoed or re-emitted — detection reports
 *      key NAMES, and every helper that produces text produces it without values.
 *   2. Legitimate requests are untouched. Over-broad matching would 400 a real
 *      API call, which is its own outage; the keys that every route in the app
 *      actually uses are asserted clean, not assumed to be.
 *   3. Stripping preserves everything that was not a secret — `next` included, so
 *      a redirect out of a tainted URL still returns the visitor to their
 *      destination — and never mutates the request's own params object.
 */
import { describe, it, expect } from 'vitest'
import {
  findCredentialKeys,
  hasCredentialParams,
  isCredentialKey,
  normalizeQueryKey,
  safeLogPath,
  scrubCredentials,
  stripCredentialParams,
} from '@/lib/credential-query'

/** Anything but empty: if a value ever survives a helper, this is what shows up. */
const SENTINEL = 'Sup3r-Secret-Pa55w0rd'

describe('key matching', () => {
  it('normalises away the case and separators that only exist for readability', () => {
    expect(normalizeQueryKey('currentPassword')).toBe('currentpassword')
    expect(normalizeQueryKey('New-Password')).toBe('newpassword')
    expect(normalizeQueryKey('CONFIRM_PASSWORD')).toBe('confirmpassword')
  })

  it('flags the password family and the bearer values', () => {
    for (const key of [
      'password',
      'Password',
      'PASSWORD',
      'currentPassword',
      'newPassword',
      'confirmPassword',
      'oldPassword',
      'passwd',
      'pwd',
      'passwordHash',
      'token',
      'accessToken',
      'csrfToken',
      'sessionToken',
      'authorization',
      'cookie',
      'apiKey',
      'secret',
      'client_secret',
      'otp',
    ]) {
      expect(isCredentialKey(key), key).toBe(true)
    }
  })

  it('leaves every query key the app actually uses alone', () => {
    // These are the parameter names read by the API routes today. None of them is
    // a secret, and refusing one would break a working screen — the list is
    // asserted rather than eyeballed because a route is free to add parameters.
    for (const key of [
      'page',
      'limit',
      'search',
      'q',
      'next',
      'tab',
      'from',
      'to',
      'since',
      'before',
      'action',
      'entityType',
      'outcome',
      'userId',
      'productId',
      'supplierId',
      'orderId',
      'referenceId',
      'referenceType',
      'location',
      'movementType',
      'paymentStatus',
      'status',
      'type',
      'format',
      'channel',
      'city',
      'active',
      'archived',
      'includeArchived',
      'unread',
      'modules',
    ]) {
      expect(isCredentialKey(key), key).toBe(false)
    }
  })
})

describe('findCredentialKeys', () => {
  it('reports the names that matched, in the spelling the caller used', () => {
    const params = new URLSearchParams(`email=a@b.pk&password=${SENTINEL}&currentPassword=x`)
    expect(findCredentialKeys(params)).toEqual(['password', 'currentPassword'])
  })

  it('accepts a raw query string, with or without the leading question mark', () => {
    expect(findCredentialKeys('?password=x')).toEqual(['password'])
    expect(findCredentialKeys('token=x')).toEqual(['token'])
    expect(findCredentialKeys('')).toEqual([])
  })

  it('returns no value anywhere in its answer', () => {
    const found = findCredentialKeys(`password=${SENTINEL}&apiKey=${SENTINEL}`)
    expect(found).toHaveLength(2)
    expect(found.join(' ')).not.toContain(SENTINEL)
    expect(hasCredentialParams(`password=${SENTINEL}`)).toBe(true)
  })

  it('counts a key once however many spellings of it appear', () => {
    expect(findCredentialKeys('password=1&Password=2&password=3')).toEqual(['password'])
  })

  it('treats a valueless key as the leak it is', () => {
    // `?password` alone still names a credential in a URL, and a URL is a URL.
    expect(findCredentialKeys('next=%2Ftasks&password')).toEqual(['password'])
  })
})

describe('stripCredentialParams', () => {
  it('removes the secrets and keeps everything else, in order', () => {
    const { params, removed } = stripCredentialParams(
      `email=a@b.pk&password=${SENTINEL}&next=%2Ftasks`
    )
    expect(params.toString()).toBe('email=a%40b.pk&next=%2Ftasks')
    expect(params.get('next')).toBe('/tasks')
    expect(removed).toEqual(['password'])
    expect(params.toString()).not.toContain(SENTINEL)
  })

  it('keeps repeated values of a legitimate key', () => {
    const { params } = stripCredentialParams('modules=tasks&modules=chat&token=x')
    expect(params.getAll('modules')).toEqual(['tasks', 'chat'])
  })

  it('leaves a clean query string byte-identical', () => {
    const { params, removed } = stripCredentialParams('page=2&limit=25&search=sofa')
    expect(params.toString()).toBe('page=2&limit=25&search=sofa')
    expect(removed).toEqual([])
  })

  it('does not mutate the params it was given', () => {
    // On a `NextURL` this object IS the request's query string; mutating it would
    // change the request the handler downstream thinks it received.
    const source = new URLSearchParams(`password=${SENTINEL}&next=%2Ftasks`)
    stripCredentialParams(source)
    expect(source.toString()).toContain('password')
  })
})

describe('scrubCredentials', () => {
  it('redacts a query string quoted inside a log line', () => {
    const line = `GET /login?email=a@b.pk&password=${SENTINEL} 200`
    const scrubbed = scrubCredentials(line)
    expect(scrubbed).not.toContain(SENTINEL)
    expect(scrubbed).toContain('password=[redacted]')
    // The rest of the line is still readable — that is what makes a log useful.
    expect(scrubbed).toContain('GET /login')
    expect(scrubbed).toContain('email=a@b.pk')
  })

  it('redacts JSON and prose shapes, not just URLs', () => {
    expect(scrubCredentials(`{"password": "${SENTINEL}"}`)).not.toContain(SENTINEL)
    expect(scrubCredentials(`currentPassword: ${SENTINEL}`)).not.toContain(SENTINEL)
    expect(scrubCredentials(`password%3D${SENTINEL}`)).not.toContain(SENTINEL)
  })

  it('reaches a secret after a harmless key in the same URL', () => {
    // The shape that used to defeat the matcher: `http` is read as a key and its
    // value would run to the end of the line, so the real pair after the `?` was
    // never even looked at. A full URL — scheme included — is what an error from
    // `fetch` or a driver actually quotes.
    for (const line of [
      `GET http://localhost/login?password=${SENTINEL} 200`,
      `redirected to http://localhost:3111/tasks?next=%2Fx&password=${SENTINEL}&limit=25`,
      `url=/login?email=a@b.pk&password=${SENTINEL} rejected`,
    ]) {
      const scrubbed = scrubCredentials(line)
      expect(scrubbed, line).not.toContain(SENTINEL)
      expect(scrubbed, line).toContain('password=[redacted]')
    }
  })

  it('covers a path-shaped secret whole', () => {
    // `/` deliberately does not end a value, so this is not cut in half.
    expect(scrubCredentials(`password=/var/secrets/login`)).toBe('password=[redacted]')
  })

  it('redacts credentials inside a connection string', () => {
    // No key named `password` appears here at all, so the name-driven rule cannot
    // see it: the secret lives in the authority part of the URL.
    const line = `MongoServerSelectionError: connect ECONNREFUSED mongodb://root:${SENTINEL}@cluster0-sha-00.mongodb.net/decoricks?authSource=admin`
    const scrubbed = scrubCredentials(line)
    expect(scrubbed).not.toContain(SENTINEL)
    expect(scrubbed).toContain('mongodb://[redacted]@cluster0-sha-00.mongodb.net')
    // Host and database survive — that is the part an operator needs.
    expect(scrubbed).toContain('ECONNREFUSED')
  })

  it('leaves an ordinary URL alone', () => {
    const line = 'fetch failed https://example.com/api/v1/orders?page=2'
    expect(scrubCredentials(line)).toBe(line)
  })

  it('leaves an ordinary error message untouched, word for word', () => {
    const line = 'E11000 duplicate key error collection: test.transactions index: idx_1'
    expect(scrubCredentials(line)).toBe(line)
  })

  it('is idempotent and never throws on awkward input', () => {
    for (const text of ['', 'password=', '===', 'a:b:c:d', '&token', 'password:x:y']) {
      const once = scrubCredentials(text)
      expect(scrubCredentials(once), text).toBe(once)
    }
  })

  it('does not redact a value just because it looks secret', () => {
    // Name-driven, deliberately: guessing what a password "looks like" redacts
    // whatever the guesser did not think of, including legitimate filters.
    const line = 'filter=price_range&sort=created_at&note=hunter2'
    expect(scrubCredentials(line)).toBe(line)
  })
})

describe('safeLogPath', () => {
  it('drops the query string rather than scrubbing it', () => {
    expect(safeLogPath(`http://localhost/login?password=${SENTINEL}`)).toBe('/login')
    expect(safeLogPath('/api/audit-log?page=2&search=x')).toBe('/api/audit-log')
  })

  it('redacts what survives a fragment that is not really a URL', () => {
    // `new URL('password=…', base)` resolves instead of throwing, so the
    // pathname-only rule on its own would hand the secret straight back.
    const out = safeLogPath(`password=${SENTINEL}`)
    expect(out).not.toContain(SENTINEL)
    expect(out).toContain('password=[redacted]')
  })
})
