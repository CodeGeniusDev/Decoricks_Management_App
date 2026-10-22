/**
 * The `idempotencyKey` field, prepared for an insert document.
 *
 * Every guarded collection (ledger, movements, purchases, orders, returns,
 * budgets, distributions, products, task cards) protects replays with a
 * **unique sparse** index on `idempotencyKey`. "Sparse" excludes documents that
 * *lack* the field — a document that carries the field with the value `null` is
 * indexed like any ordinary key, and only one such document can exist.
 *
 * The BSON serializer converts `undefined` to `null`, so writing the natural
 * `idempotencyKey: input.idempotencyKey` for a request that supplied no key
 * stores `null`. The first keyless write succeeds and plants that row; every
 * later keyless write to the same collection then dies on E11000 and surfaces
 * as a misleading "already exists" error. A keyless task card hit exactly this
 * in an earlier phase (`tasks` now omits the field, and the rest did not).
 *
 * A keyless insert must therefore omit the field entirely: it stays out of the
 * index, so genuine replays of a real key are still rejected.
 */
export const idempotencyField = (key?: string | null): { idempotencyKey?: string } =>
  key ? { idempotencyKey: key } : {}
