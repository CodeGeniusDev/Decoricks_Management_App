'use client'

/**
 * Products screen (SPEC §5.1).
 *
 * Product, SKU (unique), variants, selling price, reorder level,
 * active/archived — and no hard deletes anywhere: the archive button is the
 * most destructive thing this screen does, because the movement ledger,
 * orders and purchases must keep resolving every product they reference.
 *
 * The cost column is the WEIGHTED AVERAGE cost, restated by purchases; it is
 * read-only here on purpose. Cost changes happen by recording a purchase, the
 * same way they happen on the shelf.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PageTransition } from '@/components/PageTransition'
import { PageHeader } from '@/components/layout/Page'
import { SubNav } from '@/components/layout/SubNav'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Modal } from '@/components/ui/Modal'
import { Table } from '@/components/ui/Table'
import { Badge } from '@/components/ui/Badge'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { ExportLink } from '@/components/ui/ExportLink'
import { Toast } from '@/components/ui/Toast'
import { ApiError, apiJson, apiDelete } from '@/lib/api-client'
import { formatPaisa } from '@/lib/money'
import { useAuth } from '@/components/auth/AuthProvider'
import { can } from '@/lib/permissions-client'
import { INVENTORY_SUBNAV, type ProductView } from '@/modules/inventory/inventory-ui'
import { ProductFormModal } from '@/modules/inventory/ProductFormModal'

const LOCATION_LABELS: Record<string, string> = {
  sheikhupura: 'Sheikhupura',
  lahore: 'Lahore',
}

type StatusFilter = 'active' | 'archived' | 'all'

export default function InventoryProductsPage() {
  const { user } = useAuth()
  const canCreate = user ? can({ role: user.role }, 'inventory', 'create') : false
  const canEdit = user ? can({ role: user.role }, 'inventory', 'edit') : false
  const canArchive = user ? can({ role: user.role }, 'inventory', 'delete') : false

  const [products, setProducts] = useState<ProductView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [status, setStatus] = useState<StatusFilter>('active')

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<ProductView | null>(null)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [archiving, setArchiving] = useState<ProductView | null>(null)

  const requestSeq = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  const load = useCallback(async () => {
    const seq = ++requestSeq.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    const params = new URLSearchParams()
    if (search.trim()) params.set('search', search.trim())
    if (category) params.set('category', category)
    if (status !== 'all') params.set('active', status === 'active' ? 'true' : 'false')

    try {
      const result = await apiJson<ProductView[]>(`/api/products?${params.toString()}`, {
        signal: controller.signal,
      })
      if (seq === requestSeq.current) {
        setProducts(result)
        setError(null)
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      if (seq === requestSeq.current) {
        setError(err instanceof Error ? err.message : 'Failed to load products')
      }
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [search, category, status])

  useEffect(() => {
    setLoading(true)
    const timer = setTimeout(() => void load(), search ? 350 : 0)
    return () => clearTimeout(timer)
  }, [load, reloadTick, search])

  // Categories present in the data, offered as picker suggestions only.
  const categories = useMemo(() => {
    const set = new Set(products.map((p) => p.category).filter(Boolean))
    return [...set].sort()
  }, [products])

  const openCreate = () => {
    setEditing(null)
    setFormOpen(true)
  }

  const openEdit = (product: ProductView) => {
    setEditing(product)
    setFormOpen(true)
  }

  const handleSaved = (product: ProductView, created: boolean) => {
    setToast({
      type: 'success',
      message: created
        ? `${product.name} added.`
        : `${product.name} updated. Existing stock and prices on past orders are untouched.`,
    })
    setReloadTick((t) => t + 1)
  }

  const confirmArchive = async () => {
    if (!archiving) return
    try {
      await apiDelete(`/api/products/${archiving._id}`)
      setToast({
        type: 'success',
        message: `${archiving.name} archived. Its stock and history stay visible; nothing was deleted.`,
      })
      setArchiving(null)
      setReloadTick((t) => t + 1)
    } catch (err) {
      setToast({
        type: 'error',
        message: err instanceof ApiError ? err.message : 'Could not archive the product.',
      })
    }
  }

  const restore = async (product: ProductView) => {
    try {
      await apiJson(`/api/products/${product._id}`, {
        method: 'PUT',
        body: JSON.stringify({ isActive: true }),
      })
      setToast({ type: 'success', message: `${product.name} re-activated.` })
      setReloadTick((t) => t + 1)
    } catch (err) {
      setToast({
        type: 'error',
        message: err instanceof ApiError ? err.message : 'Could not re-activate the product.',
      })
    }
  }

  const exportHref = useMemo(() => {
    const params = new URLSearchParams()
    if (search.trim()) params.set('search', search.trim())
    if (category) params.set('category', category)
    if (status !== 'all') params.set('active', status === 'active' ? 'true' : 'false')
    const query = params.toString()
    return `/api/products/export${query ? `?${query}` : ''}`
  }, [search, category, status])

  const columns = [
    { key: 'name', label: 'Product' },
    { key: 'category', label: 'Category' },
    { key: 'cost', label: 'Avg cost' },
    { key: 'price', label: 'Selling price' },
    { key: 'stock', label: 'Stock' },
    { key: 'reorder', label: 'Reorder at' },
    { key: 'status', label: 'Status' },
    ...(canEdit || canArchive ? [{ key: 'actions', label: 'Actions' }] : []),
  ]

  const rows = products.map((product) => {
    const sheikhupura = product.stockByLocation?.sheikhupura ?? 0
    const lahore = product.stockByLocation?.lahore ?? 0
    return {
      _id: product._id,
      name: (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-decoricks-dark">{product.name}</p>
          <p className="text-xs text-ink-muted">{product.sku}</p>
          {(product.variants?.length ?? 0) > 0 && (
            <p className="text-xs text-ink-muted">{product.variants!.length} variants</p>
          )}
        </div>
      ),
      category: product.category || '—',
      cost: formatPaisa(product.cost),
      price: <span className="font-medium text-decoricks-dark">{formatPaisa(product.sellingPrice)}</span>,
      stock: (
        <span>
          {sheikhupura + lahore}
          <span className="ml-1 text-xs text-ink-muted">
            (S: {sheikhupura} · L: {lahore})
          </span>
        </span>
      ),
      reorder: product.reorderLevel === null || product.reorderLevel === undefined ? '—' : product.reorderLevel,
      status: product.isActive ? (
        <Badge variant="success" size="sm">
          Active
        </Badge>
      ) : (
        <Badge variant="default" size="sm">
          Archived
        </Badge>
      ),
      actions: (
        <div className="flex gap-1">
          {canEdit && (
            <Button variant="ghost" size="sm" onClick={() => openEdit(product)}>
              Edit
            </Button>
          )}
          {canArchive && product.isActive && (
            <Button variant="ghost" size="sm" onClick={() => setArchiving(product)}>
              Archive
            </Button>
          )}
          {canEdit && !product.isActive && (
            <Button variant="ghost" size="sm" onClick={() => void restore(product)}>
              Restore
            </Button>
          )}
        </div>
      ),
    }
  })

  return (
    <PageTransition>
      <PageHeader
        title="Products"
        description="Catalogue with SKUs, variants, prices and reorder levels. Products are archived, never deleted."
        actions={
          <>
            <ExportLink href={exportHref} />
            {canCreate && <Button onClick={openCreate}>New product</Button>}
          </>
        }
      />

      <SubNav items={INVENTORY_SUBNAV} />

      {toast && (
        <div className="fixed top-20 right-4 z-50 max-w-[90vw]">
          <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
        </div>
      )}

      {/* Filters */}
      <Card className="mb-4 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Input
            label="Search"
            placeholder="Name or SKU…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select
            label="Category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            options={[
              { value: '', label: 'All categories' },
              ...categories.map((c) => ({ value: c, label: c })),
            ]}
          />
          <Select
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
            options={[
              { value: 'active', label: 'Active' },
              { value: 'archived', label: 'Archived' },
              { value: 'all', label: 'All' },
            ]}
          />
          <div className="flex items-end">
            <Button
              variant="outline"
              onClick={() => {
                setSearch('')
                setCategory('')
                setStatus('active')
              }}
            >
              Clear filters
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        {loading ? (
          <div className="p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} variant="rect" className="mb-2 h-12" />
            ))}
          </div>
        ) : error ? (
          <ErrorState
            title="Could not load products"
            description={error}
            action={{ label: 'Retry', onClick: () => void load() }}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title={search || category || status !== 'active' ? 'No products match' : 'No products yet'}
            description={
              search || category || status !== 'active'
                ? 'Try widening the filters.'
                : 'Add your first product to start tracking stock.'
            }
            action={canCreate ? { label: 'New product', onClick: openCreate } : undefined}
          />
        ) : (
          <>
            <div className="hidden md:block">
              <Table caption="Products" columns={columns} data={rows} rowKey="_id" />
            </div>
            <ul className="divide-y divide-line-subtle md:hidden">
              {products.map((product) => (
                <li key={product._id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-decoricks-dark">{product.name}</p>
                      <p className="text-xs text-ink-muted">
                        {product.sku} · {product.category || 'Uncategorised'}
                      </p>
                    </div>
                    {product.isActive ? (
                      <Badge variant="success" size="sm">
                        Active
                      </Badge>
                    ) : (
                      <Badge variant="default" size="sm">
                        Archived
                      </Badge>
                    )}
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-ink-secondary">
                    <p>
                      Avg cost: <span className="font-medium text-decoricks-dark">{formatPaisa(product.cost)}</span>
                    </p>
                    <p>
                      Price:{' '}
                      <span className="font-medium text-decoricks-dark">
                        {formatPaisa(product.sellingPrice)}
                      </span>
                    </p>
                    <p>
                      Stock: {LOCATION_LABELS.sheikhupura} {product.stockByLocation?.sheikhupura ?? 0} ·{' '}
                      {LOCATION_LABELS.lahore} {product.stockByLocation?.lahore ?? 0}
                    </p>
                    <p>
                      Reorder at: {product.reorderLevel ?? '—'}
                    </p>
                  </div>
                  {(canEdit || canArchive) && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {canEdit && (
                        <Button variant="ghost" size="sm" onClick={() => openEdit(product)}>
                          Edit
                        </Button>
                      )}
                      {canArchive && product.isActive && (
                        <Button variant="ghost" size="sm" onClick={() => setArchiving(product)}>
                          Archive
                        </Button>
                      )}
                      {canEdit && !product.isActive && (
                        <Button variant="ghost" size="sm" onClick={() => void restore(product)}>
                          Restore
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <p className="px-4 pb-3 pt-1 text-xs text-ink-muted">
              {products.length} product{products.length === 1 ? '' : 's'} shown
            </p>
          </>
        )}
      </Card>

      {/* Archive confirmation — the only destructive-looking action here. */}
      <Modal
        isOpen={archiving !== null}
        onClose={() => setArchiving(null)}
        title={archiving ? `Archive ${archiving.name}?` : 'Archive product?'}
        description="Archiving hides the product from new orders and purchases."
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setArchiving(null)}>
              Cancel
            </Button>
            <Button onClick={() => void confirmArchive()}>Archive</Button>
          </>
        }
      >
        <p className="text-sm text-ink-secondary">
          Its stock, movements, orders and purchases are kept — nothing is deleted. You can
          restore the product later from the Archived filter.
        </p>
      </Modal>

      <ProductFormModal
        isOpen={formOpen}
        onClose={() => setFormOpen(false)}
        product={editing}
        categories={categories}
        onSaved={handleSaved}
      />
    </PageTransition>
  )
}
