import { Db, Collection, ObjectId } from 'mongodb'

export type Location = 'sheikhupura' | 'lahore'

/**
 * A variant is a selling configuration of the same product (size, colour,
 * fabric). It shares the product's stock pool; an optional `sellingPrice`
 * override (paisa) lets one listing sell at different prices. Free-text
 * `name` only — no invented variant taxonomies.
 */
export interface ProductVariant {
  name: string
  sku?: string
  sellingPrice?: number // paisa override; falls back to the product price
}

export interface Product {
  _id?: ObjectId
  sku: string
  name: string
  description?: string
  category: string
  cost: number // paisa, weighted average cost
  sellingPrice: number // paisa
  /** Units below which the product appears on the low-stock list. */
  reorderLevel?: number
  variants?: ProductVariant[]
  /** Archive flag only; Phase 5 forbids hard deletes (SPEC §3.1.3). */
  isActive: boolean
  /** Unique sparse index: replays of the same create return the original. */
  idempotencyKey?: string
  createdAt: Date
  updatedAt: Date
}

export interface Stock {
  _id?: ObjectId
  productId: ObjectId
  location: Location
  quantity: number
  lastUpdated: Date
  updatedAt: Date
}

export const getProductCollection = (db: Db): Collection<Product> => {
  return db.collection<Product>('products')
}

export const getStockCollection = (db: Db): Collection<Stock> => {
  return db.collection<Stock>('stock')
}

export const getCategoryCollection = (db: Db): Collection<{ name: string }> => {
  return db.collection<{ name: string }>('productCategories')
}

let productIndexesPromise: Promise<void> | null = null

/**
 * SKU uniqueness used to be a read-then-write check in the route, which two
 * concurrent requests could both pass. The unique index is the real arbiter.
 * Memoised per process; failures logged, never thrown.
 */
export function ensureProductIndexes(db: Db): Promise<void> {
  if (!productIndexesPromise) {
    productIndexesPromise = (async () => {
      try {
        await Promise.all([
          getProductCollection(db).createIndex({ sku: 1 }, { unique: true, name: 'products_sku_unique' }),
          getProductCollection(db).createIndex({ isActive: 1 }, { name: 'products_isActive' }),
          getProductCollection(db).createIndex({ category: 1 }, { name: 'products_category' }),
          getProductCollection(db).createIndex(
            { idempotencyKey: 1 },
            { unique: true, sparse: true, name: 'products_idempotency_unique' }
          ),
        ])
      } catch (error) {
        productIndexesPromise = null
        console.error('ensureProductIndexes failed:', error)
      }
    })()
  }
  return productIndexesPromise
}

export const productToJSON = (p: Product) => ({
  _id: p._id?.toString(),
  sku: p.sku,
  name: p.name,
  description: p.description,
  category: p.category,
  cost: p.cost,
  sellingPrice: p.sellingPrice,
  reorderLevel: p.reorderLevel,
  variants: p.variants,
  isActive: p.isActive,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
})

export const stockToJSON = (s: Stock) => ({
  _id: s._id?.toString(),
  productId: s.productId.toString(),
  location: s.location,
  quantity: s.quantity,
  lastUpdated: s.lastUpdated,
  updatedAt: s.updatedAt,
})
