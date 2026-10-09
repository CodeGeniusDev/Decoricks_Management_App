'use client'

import { IconPlus } from '@/components/ui/icons'
import { useState, useEffect, useCallback, useRef } from 'react'
import { PageTransition } from '@/components/PageTransition'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Table } from '@/components/ui/Table'
import { Modal } from '@/components/ui/Modal'
import { Badge } from '@/components/ui/Badge'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { Toast } from '@/components/ui/Toast'
import { formatPaisa } from '@/lib/money'
import { apiFetch } from '@/lib/api-client'

interface Product {
  _id: string
  sku: string
  name: string
  description?: string
  category: string
  cost: number // paisa
  sellingPrice: number // paisa
  isActive: boolean
  createdAt: string
  updatedAt: string
  stockByLocation?: Record<string, number>
  totalQuantity?: number
}

interface Stock {
  _id: string
  productId: string
  productName: string
  location: 'sheikhupura' | 'lahore'
  quantity: number
  lastUpdated: string
}

const CATEGORIES = [
  { value: 'home_decor', label: 'Home Decor' },
  { value: 'handmade', label: 'Handmade' },
  { value: 'ceramic', label: 'Ceramic' },
  { value: 'woodwork', label: 'Woodwork' },
  { value: 'textiles', label: 'Textiles' },
  { value: 'other', label: 'Other' },
]

const LOCATIONS: { value: string; label: string }[] = [
  { value: 'sheikhupura', label: 'Sheikhupura' },
  { value: 'lahore', label: 'Lahore' },
]

const STOCK_COLUMNS = [
  { key: 'productName', label: 'Product' },
  { key: 'sku', label: 'SKU' },
  { key: 'location', label: 'Location' },
  { key: 'quantity', label: 'Stock' },
  { key: 'value', label: 'Value' },
  { key: 'status', label: 'Status' },
]

export default function InventoryPage() {
  const [activeTab, setActiveTab] = useState<'products' | 'stock'>('products')
  const [products, setProducts] = useState<Product[]>([])
  const [stocks, setStocks] = useState<Stock[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const isSubmittingRef = useRef(false)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [modalMode, setModalMode] = useState<'product' | 'transfer'>('product')
  const [toastMessage, setToastMessage] = useState<{
    type: 'success' | 'error' | 'info' | 'warning'
    message: string
  } | null>(null)

  // Product form state preserved across modal open/close
  const [formSku, setFormSku] = useState('')
  const [formName, setFormName] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formCategory, setFormCategory] = useState('home_decor')
  const [formCost, setFormCost] = useState('')
  const [formSellingPrice, setFormSellingPrice] = useState('')
  const [formIsActive, setFormIsActive] = useState(true)
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})

  // Transfer form state
  const [transferFrom, setTransferFrom] = useState('sheikhupura')
  const [transferTo, setTransferTo] = useState('lahore')
  const [transferQuantity, setTransferQuantity] = useState(1)
  const [transferProduct, setTransferProduct] = useState('')

  const fetchProducts = useCallback(async () => {
    try {
      setLoading(true)
      setLoadError(null)

      const [productsRes, stockRes] = await Promise.all([apiFetch('/api/products'), apiFetch('/api/stock')])
      const productsBody = await productsRes.json()
      const stockBody = await stockRes.json()

      if (!productsRes.ok || !productsBody.success) {
        throw new Error(productsBody?.error?.message || 'Failed to load products')
      }
      if (!stockRes.ok || !stockBody.success) {
        throw new Error(stockBody?.error?.message || 'Failed to load stock')
      }

      setProducts(productsBody.data)
      setStocks(stockBody.data)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load inventory data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchProducts()
  }, [fetchProducts])

  const resetForm = () => {
    setFormSku('')
    setFormName('')
    setFormDescription('')
    setFormCategory('home_decor')
    setFormCost('')
    setFormSellingPrice('')
    setFormIsActive(true)
    setFormErrors({})
    setEditingProduct(null)
  }

  const openProductModal = () => {
    setModalMode('product')
    resetForm()
    setIsModalOpen(true)
  }

  const openEditProductModal = (product: Product) => {
    setModalMode('product')
    setEditingProduct(product)
    setFormSku(product.sku)
    setFormName(product.name)
    setFormDescription(product.description || '')
    setFormCategory(product.category)
    setFormCost((product.cost / 100).toString())
    setFormSellingPrice((product.sellingPrice / 100).toString())
    setFormIsActive(product.isActive)
    setFormErrors({})
    setIsModalOpen(true)
  }

  const openTransferModal = () => {
    setModalMode('transfer')
    setTransferFrom('sheikhupura')
    setTransferTo('lahore')
    setTransferQuantity(1)
    setTransferProduct('')
    setFormErrors({})
    setIsModalOpen(true)
  }

  const closeModal = () => {
    setIsModalOpen(false)
    resetForm()
  }

  const validateProductForm = (): boolean => {
    const errors: Record<string, string> = {}
    if (!formSku.trim()) errors.sku = 'SKU is required'
    if (!formName.trim()) errors.name = 'Name is required'
    if (!formCost || parseFloat(formCost) <= 0) errors.cost = 'Cost must be positive'
    if (!formSellingPrice || parseFloat(formSellingPrice) <= 0) errors.sellingPrice = 'Selling price must be positive'
    setFormErrors(errors)
    return Object.keys(errors).length === 0
  }

  const handleProductSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (isSubmittingRef.current) return
    if (!validateProductForm()) return

    isSubmittingRef.current = true
    setIsSubmitting(true)
    try {
      const payload = {
        sku: formSku.trim(),
        name: formName.trim(),
        description: formDescription.trim() || undefined,
        category: formCategory,
        // Stored in paisa; the form collects PKR.
        cost: Math.round(parseFloat(formCost) * 100),
        sellingPrice: Math.round(parseFloat(formSellingPrice) * 100),
        isActive: formIsActive,
      }

      const res = await apiFetch(editingProduct ? `/api/products/${editingProduct._id}` : '/api/products', {
        method: editingProduct ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json()

      if (!res.ok || !body.success) {
        if (Array.isArray(body?.error?.details)) {
          const fieldErrors: Record<string, string> = {}
          for (const d of body.error.details) {
            if (d?.path) fieldErrors[d.path] = d.message
          }
          setFormErrors(fieldErrors)
        }
        throw new Error(body?.error?.message || 'Could not save product')
      }

      setToastMessage({
        type: 'success',
        message: editingProduct ? 'Product updated successfully' : 'Product created successfully',
      })
      closeModal()
      await fetchProducts()
    } catch (err) {
      setFormErrors((prev) => ({
        ...prev,
        general: err instanceof Error ? err.message : 'Could not save product',
      }))
    } finally {
      isSubmittingRef.current = false
      setIsSubmitting(false)
    }
  }

  const handleTransferSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (isSubmittingRef.current) return

    const product = products.find((p) => p._id === transferProduct)
    if (!product) {
      setFormErrors({ general: 'Select a product to transfer' })
      return
    }

    isSubmittingRef.current = true
    setIsSubmitting(true)
    try {
      const res = await apiFetch('/api/stock/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: product._id,
          quantity: transferQuantity,
          fromLocation: transferFrom,
          toLocation: transferTo,
        }),
      })
      const body = await res.json()

      if (!res.ok || !body.success) {
        throw new Error(body?.error?.message || 'Could not transfer stock')
      }

      setToastMessage({
        type: 'success',
        message: `Transferred ${transferQuantity} unit(s) ${transferFrom} → ${transferTo}`,
      })
      closeModal()
      await fetchProducts()
    } catch (err) {
      setFormErrors({ general: err instanceof Error ? err.message : 'Could not transfer stock' })
    } finally {
      isSubmittingRef.current = false
      setIsSubmitting(false)
    }
  }

  const deleteProduct = async (productId: string) => {
    if (!confirm('Are you sure you want to delete this product?')) return

    const previousProducts = products
    const previousStocks = stocks
    setProducts((current) => current.filter((p) => p._id !== productId))
    setStocks((current) => current.filter((s) => s.productId !== productId))

    try {
      const res = await apiFetch(`/api/products/${productId}`, { method: 'DELETE' })
      const body = await res.json()
      if (!res.ok || !body.success) {
        setProducts(previousProducts)
        setStocks(previousStocks)
        throw new Error(body?.error?.message || 'Could not delete product')
      }
      setToastMessage({ type: 'success', message: 'Product deleted' })
      await fetchProducts()
    } catch (err) {
      setProducts(previousProducts)
      setStocks(previousStocks)
      setToastMessage({
        type: 'error',
        message: err instanceof Error ? err.message : 'Could not delete product',
      })
    }
  }

  const toggleProductStatus = async (product: Product) => {
    const nextActive = !product.isActive
    const previous = products
    setProducts((current) =>
      current.map((p) => (p._id === product._id ? { ...p, isActive: nextActive } : p))
    )

    try {
      const res = await apiFetch(`/api/products/${product._id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: nextActive }),
      })
      const body = await res.json()
      if (!res.ok || !body.success) throw new Error(body?.error?.message || 'Could not update product')

      setToastMessage({ type: 'info', message: `Product ${nextActive ? 'activated' : 'deactivated'}` })
      await fetchProducts()
    } catch (err) {
      setProducts(previous)
      setToastMessage({
        type: 'error',
        message: err instanceof Error ? err.message : 'Could not update product',
      })
    }
  }

  const getStockForProduct = (productId: string, location: string) => {
    return stocks.find((s) => s.productId === productId && s.location === location)
  }

  const isLowStock = (quantity: number) => quantity < 5

  const productColumns = [
    { key: 'sku', label: 'SKU' },
    { key: 'name', label: 'Name' },
    { key: 'category', label: 'Category' },
    { key: 'cost', label: 'Cost (PKR)' },
    { key: 'sellingPrice', label: 'Price (PKR)' },
    { key: 'stock', label: 'Total Stock' },
    { key: 'status', label: 'Status' },
    { key: 'actions', label: 'Actions' },
  ]

  const productTableData = products.map((product) => {
    const skStock = getStockForProduct(product._id, 'sheikhupura')
    const lhrStock = getStockForProduct(product._id, 'lahore')

    return {
      sku: product.sku,
      name: product.name,
      category: product.category,
      cost: formatPaisa(product.cost),
      sellingPrice: formatPaisa(product.sellingPrice),
      stock: (
        <div className="flex gap-2 text-sm">
          <span>SH: {skStock?.quantity ?? 0}</span>
          <span>LHR: {lhrStock?.quantity ?? 0}</span>
        </div>
      ),
      status: (
        <Badge variant={product.isActive ? 'success' : 'warning'}>
          {product.isActive ? 'Active' : 'Inactive'}
        </Badge>
      ),
      actions: (
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => openEditProductModal(product)}>
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => toggleProductStatus(product)}
          >
            {product.isActive ? 'Deactivate' : 'Activate'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => deleteProduct(product._id)}>
            Del
          </Button>
        </div>
      ),
    }
  })

  const stockTableData = stocks.map((s) => {
    const product = products.find((p) => p._id === s.productId)
    const cost = product?.cost || 0
    const value = s.quantity * cost

    return {
      productName: s.productName,
      sku: product?.sku || '-',
      location: s.location,
      quantity: (
        <span className={isLowStock(s.quantity) ? 'text-red-500 font-medium' : ''}>
          {s.quantity}
        </span>
      ),
      value: formatPaisa(value),
      status: isLowStock(s.quantity) ? (
        <Badge variant="error">Low Stock</Badge>
      ) : (
        <Badge variant="success">OK</Badge>
      ),
    }
  })

  if (loading) {
    return (
      <PageTransition>
        <h1 className="text-2xl font-bold text-decoricks-dark mb-6">Inventory</h1>
        <Skeleton variant="rect" className="h-96" />
      </PageTransition>
    )
  }

  return (
    <PageTransition>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-decoricks-dark">Inventory</h1>
        <div className="flex gap-2">
          {activeTab === 'stock' && (
            <Button variant="outline" size="sm" onClick={openTransferModal}>
              Transfer Stock
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={activeTab === 'products' ? openProductModal : openProductModal}
          >
            <IconPlus size={16}  />
            {activeTab === 'products' ? 'Add Product' : 'Add Product'}
          </Button>
        </div>
      </div>

      {/* Tab Navigation - no page reload */}
      <div className="flex gap-2 mb-4 border-b-2 border-decoricks-dark/20">
        <button
          type="button"
          onClick={() => setActiveTab('products')}
          className={`px-4 py-2 rounded-t-lg text-sm font-medium transition-colors ${
            activeTab === 'products'
              ? 'bg-decoricks-brown text-decoricks-light'
              : 'text-decoricks-dark/60 hover:text-decoricks-dark hover:bg-decoricks-dark/5'
          }`}
        >
          Products
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('stock')}
          className={`px-4 py-2 rounded-t-lg text-sm font-medium transition-colors ${
            activeTab === 'stock'
              ? 'bg-decoricks-brown text-decoricks-light'
              : 'text-decoricks-dark/60 hover:text-decoricks-dark hover:bg-decoricks-dark/5'
          }`}
        >
          Stock Levels
        </button>
      </div>

      {/* Toast */}
      {toastMessage && (
        <div className="fixed top-20 right-4 z-50">
          <Toast
            message={toastMessage.message}
            type={toastMessage.type}
            onClose={() => setToastMessage(null)}
          />
        </div>
      )}

      {loadError && (
        <Card variant="default" className="p-6 mb-6 border-red-200">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-decoricks-dark">Could not load inventory</h2>
              <p className="text-sm text-decoricks-dark/60">{loadError}</p>
            </div>
            <Button variant="outline" onClick={fetchProducts} type="button">
              Try again
            </Button>
          </div>
        </Card>
      )}

      {activeTab === 'products' ? (
        products.length === 0 ? (
          <EmptyState
            title="No products yet"
            description="Add products to manage inventory. This list only shows products you have added."
            action={{ label: 'Add Product', onClick: openProductModal }}
          />
        ) : (
          <Card className="mb-6">
            <div className="p-4">
              <Table
                columns={productColumns}
                data={productTableData}
              />
            </div>
          </Card>
        )
      ) : (
        <div>
          {/* Stock summary */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
            <Card className="p-6">
              <h3 className="text-lg font-semibold text-decoricks-dark mb-4">Sheikhupura</h3>
              {(() => {
                const shStocks = stocks.filter((s) => s.location === 'sheikhupura')
                const totalValue = shStocks.reduce((sum, s) => {
                  const product = products.find((p) => p._id === s.productId)
                  return sum + s.quantity * (product?.cost || 0)
                }, 0)
                return (
                  <>
                    <p className="text-2xl font-bold text-decoricks-brown">
                      {shStocks.reduce((sum, s) => sum + s.quantity, 0)} units
                    </p>
                    <p className="text-sm text-decoricks-dark/60 mt-1">
                      Value: {formatPaisa(totalValue)}
                    </p>
                  </>
                )
              })()}
            </Card>
            <Card className="p-6">
              <h3 className="text-lg font-semibold text-decoricks-dark mb-4">Lahore</h3>
              {(() => {
                const lhrStocks = stocks.filter((s) => s.location === 'lahore')
                const totalValue = lhrStocks.reduce((sum, s) => {
                  const product = products.find((p) => p._id === s.productId)
                  return sum + s.quantity * (product?.cost || 0)
                }, 0)
                return (
                  <>
                    <p className="text-2xl font-bold text-decoricks-brown">
                      {lhrStocks.reduce((sum, s) => sum + s.quantity, 0)} units
                    </p>
                    <p className="text-sm text-decoricks-dark/60 mt-1">
                      Value: {formatPaisa(totalValue)}
                    </p>
                  </>
                )
              })()}
            </Card>
          </div>

          {/* Low stock alerts */}
          {stocks.some((s) => isLowStock(s.quantity) && s.quantity > 0) && (
            <Card className="p-4 mb-6 border-yellow-200">
              <h3 className="text-sm font-semibold text-yellow-800 mb-2">Low Stock Alerts</h3>
              {stocks.filter((s) => isLowStock(s.quantity) && s.quantity > 0).map((s) => (
                <p key={s._id} className="text-sm text-yellow-700">
                  {s.productName} ({s.location}): {s.quantity} units remaining
                </p>
              ))}
            </Card>
          )}

          {stocks.length === 0 ? (
            <EmptyState
              title="No stock records yet"
              description="Stock levels appear here once products have stock at Sheikhupura or Lahore."
              action={{ label: 'Add Product', onClick: openProductModal }}
            />
          ) : (
            <Card className="mb-6">
              <div className="p-4">
                <Table columns={STOCK_COLUMNS} data={stockTableData} />
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Modal for product add/edit or transfer */}
      <Modal
        isOpen={isModalOpen}
        onClose={closeModal}
        title={
          modalMode === 'transfer'
            ? 'Transfer Stock'
            : editingProduct
            ? 'Edit Product'
            : 'Add Product'
        }
        size="lg"
      >
        {modalMode === 'transfer' ? (
          <form onSubmit={handleTransferSubmit} className="space-y-4">
            <Select
              label="Product"
              options={products.map((p) => ({ value: p._id, label: `${p.name} (${p.sku})` }))}
              value={transferProduct}
              onChange={(e) => setTransferProduct(e.target.value)}
              error={formErrors.product}
            />
            <div className="grid grid-cols-2 gap-4">
              <Select
                label="From"
                options={LOCATIONS}
                value={transferFrom}
                onChange={(e) => setTransferFrom(e.target.value)}
                error={formErrors.from}
              />
              <Select
                label="To"
                options={LOCATIONS}
                value={transferTo}
                onChange={(e) => setTransferTo(e.target.value)}
                error={formErrors.to}
              />
            </div>
            <Input
              label="Quantity"
              type="number"
              min={1}
              value={transferQuantity.toString()}
              onChange={(e) => setTransferQuantity(parseInt(e.target.value) || 1)}
              error={formErrors.quantity}
            />
            {formErrors.general && <p className="text-sm text-red-500">{formErrors.general}</p>}
            <div className="flex justify-end gap-2 pt-4">
              <Button variant="outline" onClick={closeModal} type="button"
              >
                Cancel
              </Button>
              <Button variant="primary" type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Transferring…' : 'Transfer Stock'}
              </Button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleProductSubmit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label="SKU"
                placeholder="e.g. HD-001"
                value={formSku}
                onChange={(e) => setFormSku(e.target.value)}
                error={formErrors.sku}
              />
              <Input
                label="Product Name"
                placeholder="Enter name..."
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                error={formErrors.name}
              />
              <Select
                label="Category"
                options={CATEGORIES}
                value={formCategory}
                onChange={(e) => setFormCategory(e.target.value)}
              />
              <Input
                label="Cost (PKR)"
                type="number"
                step="0.01"
                value={formCost}
                onChange={(e) => setFormCost(e.target.value)}
                error={formErrors.cost}
              />
              <Input
                label="Selling Price (PKR)"
                type="number"
                step="0.01"
                value={formSellingPrice}
                onChange={(e) => setFormSellingPrice(e.target.value)}
                error={formErrors.sellingPrice}
              />
              <div className="flex items-end">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={formIsActive}
                    onChange={(e) => setFormIsActive(e.target.checked)}
                    className="w-4 h-4"
                  />
                  <span className="text-sm text-decoricks-dark">Active</span>
                </label>
              </div>
            </div>
            <Textarea
              label="Description (optional)"
              placeholder="Enter description..."
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              rows={3}
            />
            {formErrors.general && <p className="text-sm text-red-500">{formErrors.general}</p>}
            <div className="flex justify-end gap-2 pt-4">
              <Button variant="outline" onClick={closeModal} type="button"
              >
                Cancel
              </Button>
              <Button variant="primary" type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Saving…' : editingProduct ? 'Update Product' : 'Create Product'}
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </PageTransition>
  )
}
