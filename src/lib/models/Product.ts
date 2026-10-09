import { Db, Collection, ObjectId } from 'mongodb'

export type Location = 'sheikhupura' | 'lahore'

export interface Product {
  _id?: ObjectId
  sku: string
  name: string
  description?: string
  category: string
  cost: number // paisa, weighted average cost
  sellingPrice: number // paisa
  isActive: boolean
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

export const productToJSON = (p: Product) => ({
  _id: p._id?.toString(),
  sku: p.sku,
  name: p.name,
  description: p.description,
  category: p.category,
  cost: p.cost,
  sellingPrice: p.sellingPrice,
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
