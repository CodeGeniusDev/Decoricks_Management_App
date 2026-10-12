'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { ApiError, apiJson } from '@/lib/api-client'
import { LOCATION_LABELS, STOCK_LOCATIONS } from '@/lib/stock-math'
import { formatPaisa } from '@/lib/money'
import { PAYMENT_METHOD_OPTIONS, type OrderView } from './sales-ui'
import type { ProductView, StockPools } from '@/modules/inventory/inventory-ui'
import {
  fieldIssues,
  karachiToday,
  newIdempotencyKey,
  paisaToInputValue,
  parseOptionalPkrAmount,
  parseQuantity,
} from '@/lib/form-helpers'

interface OrderFormModalProps {
  isOpen: boolean
  onClose: () => void
  /** Null for a create; the stored order for a pre-dispatch edit. */
  order: OrderView | null
  products: ProductView[]
  /** Keyed `${productId}|${location}` — the pools the reservation is checked against. */
  pools: Record<string, StockPools>
  /** Display mirror of `authorizeStockWrite`; the API is the authority. */
  canWriteLocation: (location: string) => boolean
  /** Channels already used, offered as suggestions only. */
  channels: string[]
  onSaved: (order: OrderView, created: boolean) => void
}

interface LineRow {
  id: string
  productId: string
  quantity: string
}

interface FormState {
  customerName: string
  customerPhone: string
  customerCity: string
  customerAddress: string
  shipFromLocation: string
  salesChannel: string
  paymentMethod: string
  shippingCost: string
  courierCharges: string
  courierName: string
  notes: string
  lines: LineRow[]
}

const newRow = (): LineRow => ({ id: newIdempotencyKey(), productId: '', quantity: '1' })

const emptyForm = (location: string): FormState => ({
  customerName: '',
  customerPhone: '',
  customerCity: '',
  customerAddress: '',
  shipFromLocation: location,
  salesChannel: '',
  paymentMethod: 'cod',
  shippingCost: '',
  courierCharges: '',
  courierName: '',
  notes: '',
  lines: [newRow()],
})

const seedForm = (order: OrderView, location: string): FormState => ({
  customerName: order.customerName,
  customerPhone: order.customerPhone,
  customerCity: order.customerCity,
  customerAddress: order.customerAddress,
  shipFromLocation: order.shipFromLocation ?? location,
  salesChannel: order.salesChannel,
  paymentMethod: order.paymentMethod || 'cod',
  shippingCost: order.shippingCost ? paisaToInputValue(order.shippingCost) : '',
  courierCharges: order.courierCharges ? paisaToInputValue(order.courierCharges) : '',
  courierName: order.courierName ?? '',
  notes: order.notes ?? '',
  lines: order.items.map((item) => ({
    id: `${item.productId}-${order._id ?? karachiToday()}`,
    productId: item.productId,
    quantity: String(item.quantity),
  })),
})

const availableFor = (
  pools: Record<string, StockPools>,
  productId: string,
  location: string
): number => pools[`${productId}|${location}`]?.available ?? 0

/**
 * OrderFormModal — create an order or edit one before dispatch.
 *
 * What the form may decide and what it may not, exactly as SPEC §5.4 has it:
 *
 *   - The browser sends **product ids and quantities**. Names, unit prices and
 *     line totals are rebuilt server-side from the products collection, so a
 *     stale tab cannot sell at a price that no longer exists and a tampered
 *     request cannot invent one.
 *   - The ship-from location is part of the order, because stock is real at a
 *     place. Creating the order reserves those units immediately: available
 *     stock drops, and a cancel or refusal restores exactly the units that were
 *     taken — never more.
 *   - `shippingCost` is what the customer is charged (it is part of the order
 *     total). `courierCharges` is what we pay the courier and becomes a ledger
 *     expense at dispatch. They are separate fields on purpose; folding them
 *     together would corrupt both revenue and margin.
 *
 * The idempotency key is minted on open and reused across failed attempts, so
 * "Save" pressed twice after a timeout cannot create two orders.
 */
export const OrderFormModal = ({
  isOpen,
  onClose,
  order,
  products,
  pools,
  canWriteLocation,
  channels,
  onSaved,
}: OrderFormModalProps) => {
  const isEdit = Boolean(order)
  const writable = useMemo(
    () => STOCK_LOCATIONS.filter((location) => canWriteLocation(location)),
    [canWriteLocation]
  )

  const [form, setForm] = useState<FormState>(() => emptyForm(writable[0] ?? ''))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const keyRef = useRef('')

  useEffect(() => {
    if (!isOpen) return
    const fallback = writable[0] ?? ''
    setForm(order ? seedForm(order, order.shipFromLocation ?? fallback) : emptyForm(fallback))
    setErrors({})
    setFormError(null)
    keyRef.current = `order-${order?._id ?? 'new'}-${newIdempotencyKey()}`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, order])

  const patch = (changes: Partial<FormState>) => setForm((current) => ({ ...current, ...changes }))

  const patchLine = (id: string, changes: Partial<LineRow>) =>
    setForm((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.id === id ? { ...line, ...changes } : line)),
    }))

  const productById = useMemo(
    () => new Map(products.map((product) => [product._id, product])),
    [products]
  )

  /** Live totals, computed from the same stored prices the server will use. */
  const totals = useMemo(() => {
    let subtotal = 0
    let shortage: { name: string; available: number } | null = null
    for (const line of form.lines) {
      const product = productById.get(line.productId)
      if (!product) continue
      const parsed = parseQuantity(line.quantity)
      if (!parsed.ok) continue
      subtotal += parsed.value * product.sellingPrice
      const available = availableFor(pools, product._id, form.shipFromLocation)
      if (parsed.value > available && available >= 0 && !shortage) {
        shortage = { name: product.name, available }
      }
    }
    const shipping = parseOptionalPkrAmount(form.shippingCost)
    const shippingPaisa = shipping.ok ? (shipping.paisa ?? 0) : 0
    return { subtotal, shippingPaisa, total: subtotal + shippingPaisa, shortage }
  }, [form.lines, form.shipFromLocation, form.shippingCost, pools, productById])

  /**
   * Validates the form and, only when it is clean, returns the resolved order
   * lines. Building the request payload from this result is what keeps the
   * totals shown on screen, the quantities validated field-by-field and the
   * array actually posted to `/api/orders` the same numbers — no second parse
   * that could quietly diverge.
   */
  type ParsedLine = { productId: string; quantity: number }

  const validate = (): { ok: true; items: ParsedLine[] } | { ok: false } => {
    const next: Record<string, string> = {}
    if (!form.customerName.trim()) next.customerName = 'Customer name is required'
    if (!form.customerPhone.trim()) next.customerPhone = 'Phone is required'
    if (!form.customerCity.trim()) next.customerCity = 'City is required'
    if (!form.customerAddress.trim()) next.customerAddress = 'Address is required'
    if (!form.salesChannel.trim()) next.salesChannel = 'Sales channel is required'
    if (!form.shipFromLocation) next.shipFromLocation = 'Choose where the order ships from'

    const shipping = parseOptionalPkrAmount(form.shippingCost)
    if (!shipping.ok) next.shippingCost = shipping.error
    const courier = parseOptionalPkrAmount(form.courierCharges)
    if (!courier.ok) next.courierCharges = courier.error

    const seen = new Set<string>()
    const items: ParsedLine[] = []
    form.lines.forEach((line, index) => {
      if (!line.productId) {
        next[`line.${index}.productId`] = 'Choose a product'
      } else if (seen.has(line.productId)) {
        next[`line.${index}.productId`] = 'This product is already on the order'
      } else {
        seen.add(line.productId)
      }
      const parsed = parseQuantity(line.quantity)
      if (!parsed.ok) next[`line.${index}.quantity`] = parsed.error
      else items.push({ productId: line.productId, quantity: parsed.value })
    })

    if (form.lines.length === 0) next.lines = 'Add at least one item to the order.'

    setErrors(next)
    if (Object.keys(next).length > 0) return { ok: false }
    return { ok: true, items }
  }

  const handleSubmit = async () => {
    if (savingRef.current) return
    const valid = validate()
    if (!valid.ok) return

    savingRef.current = true
    setSaving(true)
    setFormError(null)

    const shipping = parseOptionalPkrAmount(form.shippingCost)
    const courier = parseOptionalPkrAmount(form.courierCharges)
    const body: Record<string, unknown> = {
      customerName: form.customerName.trim(),
      customerPhone: form.customerPhone.trim(),
      customerCity: form.customerCity.trim(),
      customerAddress: form.customerAddress.trim(),
      salesChannel: form.salesChannel.trim(),
      shipFromLocation: form.shipFromLocation,
      paymentMethod: form.paymentMethod,
      items: valid.items,
    }
    if (shipping.ok && shipping.paisa !== null) body.shippingCost = shipping.paisa
    if (courier.ok && courier.paisa !== null) body.courierCharges = courier.paisa
    if (form.courierName.trim()) body.courierName = form.courierName.trim()
    if (form.notes.trim()) body.notes = form.notes.trim()

    try {
      const saved = isEdit
        ? await apiJson<OrderView>(`/api/orders/${order!._id}`, {
            method: 'PUT',
            body: JSON.stringify(body),
          })
        : await apiJson<{ order: OrderView; replay?: boolean }>('/api/orders', {
            method: 'POST',
            body: JSON.stringify({ ...body, idempotencyKey: keyRef.current }),
          }).then((result) => result.order)

      onSaved(saved, !isEdit)
      onClose()
    } catch (err) {
      if (err instanceof ApiError) {
        const issues = fieldIssues(err.details)
        setErrors(issues)
        if (err.code === 'INSUFFICIENT_STOCK') {
          setFormError(
            `${err.message || 'Not enough stock at that location.'} The order was not created — stock at the other location may differ.`
          )
        } else {
          setFormError(
            Object.values(issues)[0] ??
              (err.isForbidden
                ? 'You do not have permission to create orders that ship from that location.'
                : err.message || 'The order could not be saved.')
          )
        }
      } else {
        setFormError('Could not reach the server. Press Save again — the retry will not create a second order.')
      }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const channelListId = 'order-channel-suggestions'
  const productOptions = [
    { value: '', label: 'Choose a product' },
    ...products
      .filter((product) => product.isActive)
      .map((product) => ({
        value: product._id,
        label: `${product.name} · ${product.sku} · ${formatPaisa(product.sellingPrice)}`,
      })),
  ]

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEdit ? `Edit ${order?.orderNumber}` : 'New order'}
      description="Prices are taken from the product listing, never typed. Creating an order reserves the units at the chosen location."
      size="xl"
      dismissible={!saving}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={saving} disabled={saving}>
            {isEdit ? 'Save changes' : 'Create order'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {formError && (
          <p role="alert" className="rounded-md bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {formError}
          </p>
        )}

        <datalist id={channelListId}>
          {channels.map((channel) => (
            <option key={channel} value={channel} />
          ))}
        </datalist>

        <fieldset className="flex flex-col gap-4" disabled={saving}>
          <legend className="text-xs font-medium text-ink-secondary">Customer</legend>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label="Name"
              required
              value={form.customerName}
              error={errors.customerName}
              onChange={(e) => patch({ customerName: e.target.value })}
            />
            <Input
              label="Phone"
              required
              value={form.customerPhone}
              error={errors.customerPhone}
              onChange={(e) => patch({ customerPhone: e.target.value })}
            />
            <Input
              label="City"
              required
              value={form.customerCity}
              error={errors.customerCity}
              onChange={(e) => patch({ customerCity: e.target.value })}
            />
            <Input
              label="Sales channel"
              required
              list={channelListId}
              placeholder="Instagram, walk-in, referral…"
              value={form.salesChannel}
              error={errors.salesChannel}
              onChange={(e) => patch({ salesChannel: e.target.value })}
            />
          </div>
          <Textarea
            label="Address"
            required
            rows={2}
            value={form.customerAddress}
            error={errors.customerAddress}
            onChange={(e) => patch({ customerAddress: e.target.value })}
          />
        </fieldset>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Select
            label="Ship from"
            required
            value={form.shipFromLocation}
            error={errors.shipFromLocation}
            onChange={(e) => patch({ shipFromLocation: e.target.value })}
            options={writable.map((location) => ({
              value: location,
              label: LOCATION_LABELS[location] ?? location,
            }))}
            disabled={saving || writable.length === 1}
          />
          <Select
            label="Payment method"
            value={form.paymentMethod}
            onChange={(e) => patch({ paymentMethod: e.target.value })}
            options={PAYMENT_METHOD_OPTIONS}
            disabled={saving}
          />
        </div>

        <div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-medium text-ink-secondary">Items</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => patch({ lines: [...form.lines, newRow()] })}
              disabled={saving}
            >
              Add item
            </Button>
          </div>

          <ul className="mt-2 flex flex-col gap-3">
            {errors.lines && (
              <li>
                <p role="alert" className="text-sm text-status-danger">
                  {errors.lines}
                </p>
              </li>
            )}
            {form.lines.map((line, index) => {
              const product = productById.get(line.productId)
              const available = product
                ? availableFor(pools, product._id, form.shipFromLocation)
                : 0
              const parsed = line.quantity.trim() ? parseQuantity(line.quantity) : null
              const lineTotal =
                product && parsed && parsed.ok ? product.sellingPrice * parsed.value : null
              const short =
                product && parsed && parsed.ok && parsed.value > available
                  ? `${available} available at ${
                      LOCATION_LABELS[form.shipFromLocation] ?? form.shipFromLocation
                    }`
                  : null

              return (
                <li
                  key={line.id}
                  className="rounded-md border border-line-subtle bg-surface-sunken p-3"
                >
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_120px_auto] sm:items-end">
                    <Select
                      label={`Item ${index + 1}`}
                      value={line.productId}
                      error={errors[`line.${index}.productId`]}
                      onChange={(e) => patchLine(line.id, { productId: e.target.value })}
                      options={productOptions}
                      disabled={saving}
                    />
                    <Input
                      label="Qty"
                      inputMode="numeric"
                      value={line.quantity}
                      error={errors[`line.${index}.quantity`]}
                      onChange={(e) => patchLine(line.id, { quantity: e.target.value })}
                      disabled={saving}
                    />
                    <div className="flex items-end gap-2 pb-1">
                      <span className="text-sm font-medium text-decoricks-dark">
                        {lineTotal !== null ? formatPaisa(lineTotal) : '—'}
                      </span>
                      {form.lines.length > 1 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            patch({ lines: form.lines.filter((item) => item.id !== line.id) })
                          }
                          disabled={saving}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  </div>
                  {short && (
                    <p className="mt-1 text-xs text-status-warning">Only {short}</p>
                  )}
                </li>
              )
            })}
          </ul>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Shipping charged to customer (PKR)"
            inputMode="decimal"
            placeholder="0"
            value={form.shippingCost}
            error={errors.shippingCost}
            hint="Part of the order total and of the income posted when cash is received."
            onChange={(e) => patch({ shippingCost: e.target.value })}
            disabled={saving}
          />
          <Input
            label="Courier charge we pay (PKR)"
            inputMode="decimal"
            placeholder="0"
            value={form.courierCharges}
            error={errors.courierCharges}
            hint="Becomes a ledger expense when the order is dispatched."
            onChange={(e) => patch({ courierCharges: e.target.value })}
            disabled={saving}
          />
          <Input
            label="Courier"
            placeholder="Optional"
            value={form.courierName}
            error={errors.courierName}
            onChange={(e) => patch({ courierName: e.target.value })}
            disabled={saving}
          />
          <div className="flex flex-col justify-end gap-1 rounded-md border border-line-subtle bg-surface-sunken px-3 py-2">
            <p className="text-xs text-ink-muted">Order total</p>
            <p className="text-lg font-semibold text-decoricks-dark">{formatPaisa(totals.total)}</p>
            <p className="text-xs text-ink-muted">
              Items {formatPaisa(totals.subtotal)}
              {totals.shippingPaisa > 0 ? ` + shipping ${formatPaisa(totals.shippingPaisa)}` : ''}
            </p>
          </div>
        </div>

        <Textarea
          label="Notes"
          rows={2}
          maxLength={2000}
          value={form.notes}
          error={errors.notes}
          onChange={(e) => patch({ notes: e.target.value })}
          disabled={saving}
        />
      </div>
    </Modal>
  )
}
