'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { ApiError, apiJson } from '@/lib/api-client'
import { LOCATION_LABELS, STOCK_LOCATIONS, weightedAverageCost } from '@/lib/stock-math'
import { formatPaisa } from '@/lib/money'
import { PAYMENT_METHODS, type AccountView } from '@/modules/finance/finance-ui'
import {
  fieldIssues,
  karachiToday,
  newIdempotencyKey,
  parsePkrAmount,
  parseQuantity,
} from '@/lib/form-helpers'
import type { ProductView, PurchaseView } from './inventory-ui'

export interface SupplierOption {
  _id: string
  name: string
}

interface PurchaseFormModalProps {
  isOpen: boolean
  onClose: () => void
  /** Active products; the picker shows the weighted average cost it will blend. */
  products: ProductView[]
  suppliers: SupplierOption[]
  accounts: AccountView[]
  /** Display mirror of `authorizeStockWrite`. */
  canWriteLocation: (location: string) => boolean
  onSaved: (purchase: PurchaseView, wacBefore: number, wacAfter: number, replayed: boolean) => void
}

/**
 * PurchaseFormModal — receive goods and pay for them in one action.
 *
 * Recording a purchase does three things on the server, in one transaction:
 * it appends a `purchase_in` movement (SPEC §3.1.5), restates the product's
 * weighted average cost (SPEC §5.3), and posts the linked `product_purchasing`
 * ledger expense. The form therefore shows the cost arithmetic before it is
 * committed: the same `weightedAverageCost` the server runs, so the preview and
 * the stored figure cannot disagree.
 *
 * The unit cost is what the supplier was actually charged — never inferred from
 * the last price. Nothing is pre-filled with invented numbers.
 */
export const PurchaseFormModal = ({
  isOpen,
  onClose,
  products,
  suppliers,
  accounts,
  canWriteLocation,
  onSaved,
}: PurchaseFormModalProps) => {
  const [productId, setProductId] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [location, setLocation] = useState('')
  const [quantity, setQuantity] = useState('')
  const [unitCost, setUnitCost] = useState('')
  const [date, setDate] = useState(karachiToday)
  const [accountId, setAccountId] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [notes, setNotes] = useState('')

  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const keyRef = useRef('')

  const writableLocations = useMemo(
    () => STOCK_LOCATIONS.filter((item) => canWriteLocation(item)),
    [canWriteLocation]
  )

  useEffect(() => {
    if (!isOpen) return
    setErrors({})
    setFormError(null)
    keyRef.current = `purchase-${newIdempotencyKey()}`
    setLocation((current) => current || writableLocations[0] || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  const product = useMemo(
    () => products.find((item) => item._id === productId) ?? null,
    [products, productId]
  )

  const parsedQty = quantity.trim() ? parseQuantity(quantity) : null
  const parsedCost = unitCost.trim() ? parsePkrAmount(unitCost) : null
  const totalPaisa =
    parsedQty && parsedQty.ok && parsedCost && parsedCost.ok ? parsedQty.value * parsedCost.paisa : null

  /** The weighted average the server will store, previewed with the same maths. */
  const wacPreview = useMemo(() => {
    if (!product || !parsedQty?.ok || !parsedCost?.ok) return null
    const heldUnits = product.stockByLocation
      ? Object.values(product.stockByLocation).reduce((sum, value) => sum + value, 0)
      : 0
    return {
      before: product.cost,
      after: weightedAverageCost(heldUnits, product.cost, parsedQty.value, parsedCost.paisa),
      heldUnits,
    }
  }, [product, parsedQty, parsedCost])

  const validate = (): boolean => {
    const next: Record<string, string> = {}
    if (!productId) next.productId = 'Choose the product received'
    if (!location) next.location = 'Choose where the stock is going'
    else if (!canWriteLocation(location)) next.location = 'You cannot write stock at this location'
    if (!parsedQty || !parsedQty.ok) next.quantity = parsedQty ? parsedQty.error : 'Quantity is required'
    if (!parsedCost || !parsedCost.ok) {
      next.unitCost = parsedCost ? parsedCost.error : 'Unit cost is required'
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) next.date = 'Choose the purchase date'
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const handleSave = async () => {
    if (savingRef.current) return
    if (!validate()) return

    savingRef.current = true
    setSaving(true)
    setFormError(null)

    try {
      const result = await apiJson<{
        purchase: PurchaseView
        wacBefore: number
        wacAfter: number
        replay?: boolean
      }>('/api/purchases', {
        method: 'POST',
        body: JSON.stringify({
          productId,
          location,
          quantity: parsedQty?.ok ? parsedQty.value : 0,
          unitCost: parsedCost?.ok ? parsedCost.paisa : 0,
          ...(supplierId ? { supplierId } : {}),
          ...(accountId ? { accountId } : {}),
          date,
          paymentMethod,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          idempotencyKey: keyRef.current,
        }),
      })
      onSaved(result.purchase, result.wacBefore, result.wacAfter, Boolean(result.replay))
      onClose()
    } catch (err) {
      if (err instanceof ApiError) {
        const issues = fieldIssues(err.details)
        setErrors(issues)
        setFormError(
          Object.values(issues)[0] ??
            (err.isForbidden
              ? 'You do not have permission to record purchases at this location.'
              : err.message || 'The purchase could not be recorded.')
        )
      } else {
        setFormError('Could not reach the server. Press Save again — the retry will not double-record.')
      }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Record a purchase"
      description="Stock comes in at a cost, the weighted average cost is restated, and the matching expense is posted to the ledger — as one action."
      size="lg"
      dismissible={!saving}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving} disabled={saving}>
            Record purchase
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

        {writableLocations.length === 0 ? (
          <p className="rounded-md bg-status-warning-bg px-3 py-2 text-sm text-status-warning">
            You cannot record purchases. Stock is written at the location the goods arrive in, and
            you do not hold that permission.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Select
                label="Product"
                value={productId}
                error={errors.productId}
                onChange={(e) => setProductId(e.target.value)}
                options={[
                  { value: '', label: 'Choose a product' },
                  ...products.map((item) => ({ value: item._id, label: `${item.name} · ${item.sku}` })),
                ]}
                disabled={saving}
              />
              <Select
                label="Supplier"
                value={supplierId}
                error={errors.supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                options={[
                  { value: '', label: 'Not recorded' },
                  ...suppliers.map((item) => ({ value: item._id, label: item.name })),
                ]}
                disabled={saving}
              />
              <Select
                label="Received into"
                value={location}
                error={errors.location}
                onChange={(e) => setLocation(e.target.value)}
                options={writableLocations.map((item) => ({
                  value: item,
                  label: LOCATION_LABELS[item] ?? item,
                }))}
                disabled={saving}
              />
              <Input
                label="Quantity"
                inputMode="numeric"
                value={quantity}
                error={errors.quantity ?? (parsedQty && !parsedQty.ok ? parsedQty.error : undefined)}
                onChange={(e) => setQuantity(e.target.value)}
                disabled={saving}
              />
              <Input
                label="Unit cost (PKR)"
                inputMode="decimal"
                value={unitCost}
                error={errors.unitCost ?? (parsedCost && !parsedCost.ok ? parsedCost.error : undefined)}
                hint={product ? `Current weighted average: ${formatPaisa(product.cost)}` : undefined}
                onChange={(e) => setUnitCost(e.target.value)}
                disabled={saving}
              />
              <Input
                label="Date (Karachi)"
                type="date"
                value={date}
                error={errors.date}
                onChange={(e) => setDate(e.target.value)}
                disabled={saving}
              />
              <Select
                label="Paid from account"
                value={accountId}
                error={errors.accountId}
                onChange={(e) => setAccountId(e.target.value)}
                options={[
                  { value: '', label: 'Automatic (business posting account)' },
                  ...accounts.map((item) => ({ value: item._id, label: item.name })),
                ]}
                disabled={saving}
              />
              <Select
                label="Payment method"
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
                options={PAYMENT_METHODS}
                disabled={saving}
              />
            </div>

            <Textarea
              label="Notes"
              rows={2}
              maxLength={2000}
              value={notes}
              error={errors.notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={saving}
            />

            {/* The arithmetic, shown before it is committed. */}
            <div className="rounded-md border border-line bg-surface-sunken p-3">
              <p className="text-xs font-medium text-ink-secondary">What this will do</p>
              <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                <div className="flex justify-between gap-3 sm:justify-start">
                  <dt className="text-ink-muted">Purchase value</dt>
                  <dd className="font-medium text-decoricks-dark">
                    {totalPaisa !== null ? formatPaisa(totalPaisa) : '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-3 sm:justify-start">
                  <dt className="text-ink-muted">Ledger expense</dt>
                  <dd className="font-medium text-decoricks-dark">
                    {totalPaisa !== null ? formatPaisa(totalPaisa) : '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-3 sm:justify-start">
                  <dt className="text-ink-muted">Weighted average before</dt>
                  <dd className="font-medium text-decoricks-dark">
                    {wacPreview ? formatPaisa(wacPreview.before) : '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-3 sm:justify-start">
                  <dt className="text-ink-muted">Weighted average after</dt>
                  <dd className="font-medium text-decoricks-dark">
                    {wacPreview ? formatPaisa(wacPreview.after) : '—'}
                  </dd>
                </div>
              </dl>
              {wacPreview && (
                <p className="mt-2 text-xs text-ink-muted">
                  ({wacPreview.heldUnits} units × {formatPaisa(wacPreview.before)} +{' '}
                  {parsedQty?.ok ? parsedQty.value : 0} × {formatPaisa(parsedCost?.ok ? parsedCost.paisa : 0)})
                  ÷ {wacPreview.heldUnits + (parsedQty?.ok ? parsedQty.value : 0)} ={' '}
                  {formatPaisa(wacPreview.after)}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
