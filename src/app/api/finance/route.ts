/**
 * `/api/finance` is retained as an alias of `/api/finance/transactions`.
 *
 * Phase 1 exposed income/expense/transfer buckets here; Phase 3 made the
 * `transactions` ledger the single write path, so this route simply re-exports
 * the ledger handlers. Keeping the path means an old client cannot fall back to
 * a second, unledgered write path.
 */
export { GET, POST } from './transactions/route'
