/**
 * Read-side tuning policy for the MongoDB driver.
 *
 * Kept apart from `src/lib/mongodb.ts` on purpose. That module owns the
 * connection and is replaced wholesale by `vi.mock` in more than twenty test
 * files, so anything imported from it — even a number — has to be re-declared in
 * every one of those mocks before it can be read. Nothing in this file imports
 * anything, so mocking the connection cannot affect it.
 */

/**
 * Documents to ask the server for in the *first* batch of a `find`.
 *
 * Round trips, not bytes, are what a large read pays. The server returns at most
 * 101 documents per batch, then needs one `getMore` round trip for each batch
 * after it — so reading a collection that has outgrown 101 rows costs an extra
 * ~65ms of pure network for every 101 rows, before the handler has done anything
 * with them. Measured on this cluster with a 205-entry ledger
 * (`scripts/db-probe.ts`, cursor-batching section): the default read is 134ms,
 * the same read with a larger first batch is 72ms, and a projection changes
 * neither — which is the proof that the cost is trips rather than payload size.
 *
 * Only reads that intend to walk a whole, still-growing collection need it: a
 * paginated read capped at 25 rows is already inside one batch. The 16 MB BSON
 * ceiling still applies, so a very large ledger simply falls back to the
 * behaviour it has today rather than buffering anything new.
 */
export const FIRST_BATCH_SIZE = 1000
