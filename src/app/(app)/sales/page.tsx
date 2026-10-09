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

interface CatalogProduct {
  _id: string
  sku: string
  name: string
  sellingPrice: number // paisa
  isActive: boolean
}

interface OrderItem {
  productId: string
  productName: string
  quantity: number
  unitPrice: number // paisa
  total: number // paisa
}

interface Order {
  _id: string
  orderNumber: string
  customerName: string
  customerPhone: string
  customerCity: string
  customerAddress: string
  items: OrderItem[]
  subtotal: number
  shippingCost: number
  total: number
  paymentMethod: 'cod'
  paymentStatus: 'pending' | 'received' | 'refunded'
  orderStatus: 'pending' | 'processing' | 'shipped' | 'delivered' | 'returned' | 'cancelled'
  codOutcome: 'pending' | 'delivered' | 'returned' | 'refused'
  courierCharges?: number
  courierName?: string
  salesChannel: string
  deliveryDate?: string
  notes?: string
  createdAt: string
  updatedAt: string
}

const ORDER_STATUSES = [
  { value: 'pending', label: 'Pending', color: 'default' },
  { value: 'processing', label: 'Processing', color: 'default' },
  { value: 'shipped', label: 'Shipped', color: 'warning' },
  { value: 'delivered', label: 'Delivered', color: 'success' },
  { value: 'returned', label: 'Returned', color: 'error' },
  { value: 'cancelled', label: 'Cancelled', color: 'error' },
]

const COD_OUTCOMES = [
  { value: 'pending', label: 'Pending' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'returned', label: 'Returned' },
  { value: 'refused', label: 'Refused' },
]

const SALES_CHANNELS = [
  { value: 'shopify', label: 'Shopify' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'other', label: 'Other' },
]

export default function SalesPage() {
  const [orders, setOrders] = useState<Order[]>([])
  const [catalog, setCatalog] = useState<CatalogProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const isSubmittingRef = useRef(false)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingOrder, setEditingOrder] = useState<Order | null>(null)
  const [toastMessage, setToastMessage] = useState<{
    type: 'success' | 'error' | 'info' | 'warning'
    message: string
  } | null>(null)

  // Form state preserved across modal open/close
  const [formCustomerName, setFormCustomerName] = useState('')
  const [formCustomerPhone, setFormCustomerPhone] = useState('')
  const [formCustomerCity, setFormCustomerCity] = useState('')
  const [formCustomerAddress, setFormCustomerAddress] = useState('')
  const [formSalesChannel, setFormSalesChannel] = useState('shopify')
  const [formNotes, setFormNotes] = useState('')
  const [formItems, setFormItems] = useState<OrderItem[]>([
    { productId: '', productName: '', quantity: 1, unitPrice: 0, total: 0 },
  ])
  const [formShippingCost, setFormShippingCost] = useState(0)
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})

  const fetchOrders = useCallback(async () => {
    try {
      setLoading(true)
      setLoadError(null)
      const [ordersRes, productsRes] = await Promise.all([
        apiFetch('/api/orders'),
        apiFetch('/api/products?active=true'),
      ])
      const body = await ordersRes.json()
      const productsBody = await productsRes.json()

      if (!ordersRes.ok || !body.success) {
        throw new Error(body?.error?.message || 'Failed to load orders')
      }
      setOrders(body.data.orders)

      // Line items must reference real products; if the catalog fails we still
      // show orders but the picker stays empty rather than inventing names.
      if (productsRes.ok && productsBody.success) setCatalog(productsBody.data)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load orders')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchOrders()
  }, [fetchOrders])

  const resetForm = () => {
    setFormCustomerName('')
    setFormCustomerPhone('')
    setFormCustomerCity('')
    setFormCustomerAddress('')
    setFormSalesChannel('shopify')
    setFormNotes('')
    setFormItems([{ productId: '', productName: '', quantity: 1, unitPrice: 0, total: 0 }])
    setFormShippingCost(0)
    setFormErrors({})
    setEditingOrder(null)
  }

  const openModal = () => {
    resetForm()
    setIsModalOpen(true)
  }

  const openEditModal = (order: Order) => {
    setEditingOrder(order)
    setFormCustomerName(order.customerName)
    setFormCustomerPhone(order.customerPhone)
    setFormCustomerCity(order.customerCity)
    setFormCustomerAddress(order.customerAddress)
    setFormSalesChannel(order.salesChannel)
    setFormNotes(order.notes || '')
    setFormItems(order.items)
    setFormShippingCost(Math.round(order.shippingCost / 100))
    setFormErrors({})
    setIsModalOpen(true)
  }

  const closeModal = () => {
    setIsModalOpen(false)
    resetForm()
  }

  // Items calculation without page reload
  const updateItem = (index: number, field: keyof OrderItem, value: string | number) => {
    const newItems = [...formItems]

    if (field === 'productId') {
      const product = catalog.find((p) => p._id === value)
      newItems[index] = {
        ...newItems[index],
        productId: value as string,
        productName: product?.name ?? '',
        // Default to the product's listed selling price; still editable below.
        unitPrice: product?.sellingPrice ?? newItems[index].unitPrice,
      }
    } else if (field === 'quantity' || field === 'unitPrice') {
      // unitPrice is entered in PKR but stored in paisa
      const stored = field === 'unitPrice' ? Math.round(Number(value) * 100) : Number(value)
      newItems[index] = { ...newItems[index], [field]: stored }
    } else {
      newItems[index] = { ...newItems[index], [field]: value }
    }

    newItems[index] = {
      ...newItems[index],
      total: newItems[index].quantity * newItems[index].unitPrice,
    }
    setFormItems(newItems)
  }

  const addItemRow = () => {
    setFormItems([...formItems, { productId: '', productName: '', quantity: 1, unitPrice: 0, total: 0 }])
  }

  const removeItemRow = (index: number) => {
    if (formItems.length > 1) {
      const newItems = [...formItems]
      newItems.splice(index, 1)
      setFormItems(newItems)
    }
  }

  const calculateSubtotal = () => {
    return formItems.reduce((sum, item) => sum + item.total, 0)
  }

  const total = calculateSubtotal() + Math.round(formShippingCost * 100)

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {}
    if (!formCustomerName.trim()) errors.customerName = 'Customer name is required'
    if (!formCustomerPhone.trim()) errors.customerPhone = 'Phone is required'
    if (!formCustomerCity.trim()) errors.customerCity = 'City is required'
    if (!formCustomerAddress.trim()) errors.customerAddress = 'Address is required'

    formItems.forEach((item, i) => {
      if (!item.productId) errors[`item_${i}_name`] = 'Select a product'
      if (item.quantity <= 0) errors[`item_${i}_qty`] = 'Quantity must be positive'
      if (item.unitPrice <= 0) errors[`item_${i}_price`] = 'Price must be positive'
    })

    setFormErrors(errors)
    return Object.keys(errors).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (isSubmittingRef.current) return
    if (!validateForm()) return

    isSubmittingRef.current = true
    setIsSubmitting(true)
    try {
      const payload = {
        customerName: formCustomerName.trim(),
        customerPhone: formCustomerPhone.trim(),
        customerCity: formCustomerCity.trim(),
        customerAddress: formCustomerAddress.trim(),
        items: formItems.map((item) => ({
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            total: item.quantity * item.unitPrice,
          })),
        shippingCost: Math.round(formShippingCost * 100),
        paymentMethod: 'cod',
        paymentStatus: 'pending',
        orderStatus: 'pending',
        codOutcome: 'pending',
        salesChannel: formSalesChannel,
        notes: formNotes.trim() || undefined,
      }

      const res = await apiFetch('/api/orders', {
        method: 'POST',
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
        throw new Error(body?.error?.message || 'Could not create order')
      }

      setToastMessage({ type: 'success', message: 'Order created successfully' })
      closeModal()
      await fetchOrders()
    } catch (err) {
      setFormErrors((prev) => ({
        ...prev,
        general: err instanceof Error ? err.message : 'Could not create order',
      }))
    } finally {
      isSubmittingRef.current = false
      setIsSubmitting(false)
    }
  }

  const updateOrderStatus = async (orderId: string, status: string) => {
    const order = orders.find((o) => o._id === orderId)
    if (!order) return

    const updates: Record<string, string> = {}
    if (status === 'delivered') {
      updates.orderStatus = 'delivered'
      updates.codOutcome = 'delivered'
      updates.paymentStatus = 'received'
    } else if (status === 'returned') {
      updates.orderStatus = 'returned'
      updates.codOutcome = 'returned'
    } else {
      updates.orderStatus = status
    }

    const previous = orders
    setOrders((current) => current.map((o) => (o._id === orderId ? { ...o, ...updates } : o)))

    try {
      const res = await apiFetch(`/api/orders/${orderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      const body = await res.json()
      if (!res.ok || !body.success) {
        setOrders(previous)
        throw new Error(body?.error?.message || 'Could not update order status')
      }

      setToastMessage({
        type: 'success',
        message:
          status === 'delivered'
            ? 'Order marked as delivered'
            : status === 'returned'
            ? 'Order marked as returned'
            : 'Order status updated',
      })
      await fetchOrders()
    } catch (err) {
      setOrders(previous)
      setToastMessage({
        type: 'error',
        message: err instanceof Error ? err.message : 'Could not update order status',
      })
    }
  }

  const deleteOrder = async (orderId: string) => {
    if (!confirm('Are you sure you want to delete this order?')) return

    const previous = orders
    setOrders((current) => current.filter((o) => o._id !== orderId))

    try {
      const res = await apiFetch(`/api/orders/${orderId}`, { method: 'DELETE' })
      const body = await res.json()
      if (!res.ok || !body.success) {
        setOrders(previous)
        throw new Error(body?.error?.message || 'Could not delete order')
      }
      setToastMessage({ type: 'success', message: 'Order deleted' })
      await fetchOrders()
    } catch (err) {
      setOrders(previous)
      setToastMessage({
        type: 'error',
        message: err instanceof Error ? err.message : 'Could not delete order',
      })
    }
  }

  const getStatusBadge = (status: string) => {
    const config = ORDER_STATUSES.find((s) => s.value === status)
    const variant = config ? (config.color as any) : 'default'
    return <Badge variant={variant}>{config ? config.label : status}</Badge>
  }

  const columns = [
    { key: 'orderNumber', label: 'Order #' },
    { key: 'customerName', label: 'Customer' },
    { key: 'total', label: 'Total' },
    { key: 'status', label: 'Status' },
    { key: 'codOutcome', label: 'COD Outcome' },
    { key: 'date', label: 'Date' },
    { key: 'actions', label: 'Actions' },
  ]

  const tableData = orders.map((order) => ({
    orderNumber: order.orderNumber,
    customerName: order.customerName,
    total: formatPaisa(order.total),
    status: getStatusBadge(order.orderStatus),
    codOutcome: getStatusBadge(order.codOutcome),
    date: new Date(order.createdAt).toLocaleDateString('en-PK'),
    actions: (
      <div className="flex gap-1">
        {order.orderStatus === 'shipped' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => updateOrderStatus(order._id, 'delivered')}
          >
            Delivered
          </Button>
        )}
        {order.orderStatus === 'delivered' && order.codOutcome === 'pending' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => updateOrderStatus(order._id, 'returned')}
          >
            Return
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => openEditModal(order)}>
          Edit
        </Button>
        <Button variant="ghost" size="sm" onClick={() => deleteOrder(order._id)}>
          Del
        </Button>
      </div>
    ),
  }))

  if (loading) {
    return (
      <PageTransition>
        <h1 className="text-2xl font-bold text-decoricks-dark mb-6">Sales</h1>
        <Skeleton variant="rect" className="h-96" />
      </PageTransition>
    )
  }

  return (
    <PageTransition>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-decoricks-dark">Sales</h1>
        <Button variant="primary" onClick={openModal}>
          <IconPlus size={16}  />
          New Order
        </Button>
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
              <h2 className="font-semibold text-decoricks-dark">Could not load orders</h2>
              <p className="text-sm text-decoricks-dark/60">{loadError}</p>
            </div>
            <Button variant="outline" onClick={fetchOrders} type="button">
              Try again
            </Button>
          </div>
        </Card>
      )}

      {!loadError && orders.length === 0 ? (
        <EmptyState
          title="No orders yet"
          description="Create your first sales order. This list only shows orders you have created."
          action={{ label: 'New Order', onClick: openModal }}
        />
      ) : (
        !loadError && (
          <Card className="mb-6">
            <div className="p-4">
              <Table columns={columns} data={tableData} />
            </div>
          </Card>
        )
      )}

      {/* Order Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={closeModal}
        title={editingOrder ? 'Edit Order' : 'New Order'}
        size="xl"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Customer Name"
              placeholder="Enter name..."
              value={formCustomerName}
              onChange={(e) => setFormCustomerName(e.target.value)}
              error={formErrors.customerName}
            />
            <Input
              label="Phone"
              placeholder="03XXXXXXXXX"
              value={formCustomerPhone}
              onChange={(e) => setFormCustomerPhone(e.target.value)}
              error={formErrors.customerPhone}
            />
            <Input
              label="City"
              placeholder="Enter city..."
              value={formCustomerCity}
              onChange={(e) => setFormCustomerCity(e.target.value)}
              error={formErrors.customerCity}
            />
            <Input
              label="Address"
              placeholder="Enter full address..."
              value={formCustomerAddress}
              onChange={(e) => setFormCustomerAddress(e.target.value)}
              error={formErrors.customerAddress}
            />
            <Select
              label="Sales Channel"
              options={SALES_CHANNELS}
              value={formSalesChannel}
              onChange={(e) => setFormSalesChannel(e.target.value)}
            />
            <Input
              label="Shipping Cost (PKR)"
              type="number"
              step="0.01"
              value={formShippingCost.toString()}
              onChange={(e) => setFormShippingCost(parseFloat(e.target.value) || 0)}
            />
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-decoricks-dark">Items</h3>

            {catalog.length === 0 && (
              <p className="text-sm text-decoricks-dark/60">
                No active products found. Add a product in Inventory before creating an order — order
                lines must reference a real product.
              </p>
            )}
            {formItems.map((item, index) => (
              <div key={index} className="grid grid-cols-1 md:grid-cols-5 gap-2 items-end">
                <Select
                  label="Product"
                  options={catalog.map((p) => ({ value: p._id, label: `${p.name} (${p.sku})` }))}
                  value={item.productId}
                  onChange={(e) => updateItem(index, 'productId', e.target.value)}
                  error={formErrors[`item_${index}_name`]}
                  className="md:col-span-2"
                />
                <Input
                  label="Qty"
                  type="number"
                  min={1}
                  value={item.quantity.toString()}
                  onChange={(e) => updateItem(index, 'quantity', parseInt(e.target.value) || 0)}
                  error={formErrors[`item_${index}_qty`]}
                />
                <Input
                  label="Unit Price"
                  type="number"
                  step="0.01"
                  value={(item.unitPrice / 100).toString()}
                  onChange={(e) => updateItem(index, 'unitPrice', parseFloat(e.target.value) || 0)}
                  error={formErrors[`item_${index}_price`]}
                />
                <div className="md:col-span-1 flex items-end">
                  <div className="text-right">
                    <span className="text-xs text-decoricks-dark/60">Total</span>
                    <p className="font-medium">{formatPaisa(item.total)}</p>
                  </div>
                  {formItems.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeItemRow(index)}
                      className="ml-2 text-red-500 hover:text-red-700"
                      aria-label="Remove item"
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
            ))}
            <Button variant="ghost" size="sm" onClick={addItemRow} type="button"
            >
              + Add Item
            </Button>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t">
            <div className="text-right">
              <p className="text-sm text-decoricks-dark/60">Subtotal: {formatPaisa(calculateSubtotal())}</p>
              <p className="text-sm text-decoricks-dark/60">Shipping: {formShippingCost.toFixed(2)}</p>
              <p className="font-bold text-lg">Total: {formatPaisa(total)}</p>
            </div>
          </div>

          <Textarea
            label="Notes (optional)"
            placeholder="Enter notes..."
            value={formNotes}
            onChange={(e) => setFormNotes(e.target.value)}
            rows={2}
          />

          {formErrors.general && <p className="text-sm text-red-500">{formErrors.general}</p>}

          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={closeModal} type="button"
            >
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : editingOrder ? 'Update Order' : 'Create Order'}
            </Button>
          </div>
        </form>
      </Modal>
    </PageTransition>
  )
}
