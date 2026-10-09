import { ObjectId, type Db } from 'mongodb'
import { getProductCollection, type Product } from '@/lib/models/Product'
import { validationError } from '@/lib/api-response'

/**
 * Resolves submitted order lines against the products collection.
 *
 * The client may only decide *what* is ordered and *how many*. Names, unit
 * prices and line totals are always rebuilt from stored products so a stale or
 * tampered client cannot record an order at an invented name or price.
 */
export interface PricedOrderItem {
  productId: ObjectId
  productName: string
  quantity: number
  unitPrice: number
  total: number
}

export type PriceItemsResult =
  | { ok: true; items: PricedOrderItem[] }
  | { ok: false; response: Response }

export async function priceOrderItems(
  submitted: Array<{ productId: string; quantity: number }>,
  db: Db
): Promise<PriceItemsResult> {
  const productCol = getProductCollection(db)
  const ids = submitted.map((i) => new ObjectId(i.productId))
  const docs = await productCol.find({ _id: { $in: ids } } as never).toArray()
  const byId = new Map<string, Product>(docs.map((d) => [String(d._id), d]))

  const missing: string[] = []
  const inactive: string[] = []
  const items: PricedOrderItem[] = []

  for (const line of submitted) {
    const product = byId.get(line.productId)
    if (!product) {
      missing.push(line.productId)
      continue
    }
    if (!product.isActive) {
      inactive.push(product.name)
      continue
    }
    items.push({
      productId: new ObjectId(product._id),
      productName: product.name,
      quantity: line.quantity,
      unitPrice: product.sellingPrice,
      total: line.quantity * product.sellingPrice,
    })
  }

  if (missing.length > 0) {
    return {
      ok: false,
      response: validationError(
        'Unknown product',
        missing.map((id) => ({ path: 'items', message: `No product with id ${id}` }))
      ),
    }
  }

  if (inactive.length > 0) {
    return {
      ok: false,
      response: validationError(
        'Product unavailable',
        inactive.map((name) => ({ path: 'items', message: `${name} is not active` }))
      ),
    }
  }

  return { ok: true, items }
}