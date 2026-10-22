/**
 * Shared MongoDB index-ensure plumbing.
 *
 * `createIndex` is idempotent only when the requested spec matches the existing
 * index exactly. When a database already holds the same key pattern under a
 * different name (85, IndexOptionsConflict) or the same name with different
 * options (86, IndexKeySpecsConflict) the driver REJECTS the call — and because
 * every `ensure*Indexes` function builds its list inside one `Promise.all`, a
 * single such index rejects the whole batch. Two things went wrong in the field
 * before this helper existed:
 *
 *   - the batch rejection reset the per-process memo, so every request on that
 *     route rebuilt the entire index set and re-logged the same raw driver error
 *     (a retry storm against an already-correct database); and
 *   - the raw stack buried the failures that DO matter, which is what Phase 5 §6
 *     asks the logs to be readable for.
 *
 * An "already exists" answer is not a failure to retry: the constraint the code
 * asked for is enforced by the index that is already there. A genuine spec drift
 * (right keys, wrong options — e.g. a non-unique index where a unique one is
 * intended) cannot be fixed from here without dropping an index, which removes a
 * live uniqueness guarantee for the length of the rebuild. That is an explicit,
 * approved maintenance operation, never an automated boot-time one.
 */

/** Codes meaning "an index for this request is already registered". */
export const INDEX_ALREADY_EXISTS_CODES = new Set([85, 86])

/** Runs a `createIndex` promise, treating an already-registered index as success. */
export const createIndexTolerant = (operation: Promise<unknown>): Promise<void> =>
  operation
    .then(() => undefined)
    .catch((error: unknown) => {
      const code = (error as { code?: number } | null)?.code
      if (typeof code === 'number' && INDEX_ALREADY_EXISTS_CODES.has(code)) return
      throw error
    })
