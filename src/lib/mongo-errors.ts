import {
  MongoNetworkError,
  MongoNetworkTimeoutError,
  MongoNotConnectedError,
  MongoServerSelectionError,
} from 'mongodb'

/**
 * Pure classification of MongoDB driver failures, kept in its own module so
 * callers that only need to *reason* about an error (for example the HTTP error
 * mapper) do not depend on the connection-management module. That module is
 * routinely mocked in route tests, and importing through it would make those
 * mocks responsible for this logic too.
 */

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
])

/**
 * True only for errors that a fresh connection could plausibly resolve:
 * network/TLS handshake failures, a cleared pool, a lost socket, or the
 * driver's own retryable labels. Everything else (validation, duplicate key,
 * authorization) is *not* transient — retrying those would only add latency.
 */
export const isTransientMongoError = (error: unknown): boolean => {
  if (error instanceof MongoNetworkError) return true
  if (error instanceof MongoNetworkTimeoutError) return true
  if (error instanceof MongoServerSelectionError) return true
  if (error instanceof MongoNotConnectedError) return true

  if (error && typeof error === 'object') {
    const candidate = error as {
      name?: string
      code?: string | number
      message?: string
      hasErrorLabel?: (label: string) => boolean
      cause?: { code?: string }
    }

    if (typeof candidate.hasErrorLabel === 'function') {
      if (
        candidate.hasErrorLabel('RetryableReadError') ||
        candidate.hasErrorLabel('RetryableWriteError')
      ) {
        return true
      }
    }

    const name = candidate.name ?? ''
    if (
      name === 'MongoNetworkError' ||
      name === 'MongoNetworkTimeoutError' ||
      name === 'MongoServerSelectionError' ||
      name === 'MongoNotConnectedError' ||
      name === 'MongoTopologyClosedError'
    ) {
      return true
    }

    if (candidate.code && TRANSIENT_CODES.has(String(candidate.code))) return true
    if (candidate.cause?.code && TRANSIENT_CODES.has(String(candidate.cause.code))) return true

    const message = typeof candidate.message === 'string' ? candidate.message : ''
    if (
      /ssl3_read_bytes|tlsv1 alert|pool .*(?:cleared|closed)|topology (?:is|was) closed|connection .*(?:closed|reset)/i.test(
        message
      )
    ) {
      return true
    }
  }

  return false
}
