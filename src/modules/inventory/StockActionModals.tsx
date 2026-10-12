'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { ApiError, apiJson } from '@/lib/api-client'
import { LOCATION_LABELS, MOVEMENT_TYPE_LABELS, STOCK_LOCATIONS } from '@/lib/stock-math'
import { formatKarachiDate } from '@/lib/date'
import {
  fieldIssues,
  newIdempotencyKey,
  parseCountedQuantity,
  parseQuantity,
} from '@/lib/form-helpers'
import type { StockPools } from './inventory-ui'

/**
 * The three stock writes a human is allowed to post.
 *
 * Available, damaged and returned quantities are DERIVED from the movement
 * ledger (SPEC §3.1.5), so none of these forms types a resulting stock figure:
 *
 *   - **Transfer** moves units between the two locations. It is neither a
 *     purchase nor a sale, so it never touches money or the ledger.
 *   - **Physical count** is the one number a person may enter. The server
 *     converts the counted quantity into a signed `adjustment` movement against
 *     what the ledger says is there, so the correction stays auditable.
 *   - **Damage / write-off** moves units out of sellable stock permanently and
 *     requires a reason.
 *
 * Each form mints one idempotency key when it opens and keeps it across failed
 * attempts: pressing Save twice after a timeout replays, it does not deduct
 * twice.
 */

export interface StockProductOption {
  _id: string
  sku: string
  name: string
}

interface ActionShellProps {
  isOpen: boolean
  onClose: () => void
  products: StockProductOption[]
  /** Keyed `${productId}|${location}`; missing entries mean zero. */
  pools: Record<string, StockPools>
  /** Display mirror of `authorizeStockWrite` — the API is the authority. */
  canWriteLocation: (location: string) => boolean
  onDone: (message: string) => void
  initialProductId?: string
  initialLocation?: string
}

const poolOf = (
  pools: Record<string, StockPools>,
  productId: string,
  location: string
): StockPools => pools[`${productId}|${location}`] ?? { available: 0, damaged: 0, returned: 0 }

const productOptions = (products: StockProductOption[]) => [
  { value: '', label: 'Choose a product' },
  ...products.map((product) => ({ value: product._id, label: `${product.name} · ${product.sku}` })),
]

const locationOptions = (canWriteLocation: (location: string) => boolean) =>
  STOCK_LOCATIONS.filter((location) => canWriteLocation(location)).map((location) => ({
    value: location,
    label: LOCATION_LABELS[location] ?? location,
  }))

/** Shared error banner so all three write the same markup. */
const ErrorBanner = ({ message }: { message: string }) => (
  <p role="alert" className="rounded-md bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
    {message}
  </p>
)

/** Ledger context line under a location picker. */
const PoolNote = ({ pool }: { pool: StockPools }) => (
  <p className="text-xs text-ink-muted">
    Ledger says: {pool.available} available
    {pool.damaged > 0 ? ` · ${pool.damaged} damaged` : ''}
    {pool.returned > 0 ? ` · ${pool.returned} returned` : ''}
  </p>
)

/* ------------------------------- submit hook ------------------------------- */

function useStockSubmit() {
  const savingRef = useRef(false)
  const keyRef = useRef('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const reset = (prefix: string) => {
    keyRef.current = `${prefix}-${newIdempotencyKey()}`
    setError(null)
    setErrors({})
  }

  const submit = async (url: string, body: Record<string, unknown>) => {
    if (savingRef.current) return false
    savingRef.current = true
    setSaving(true)
    setError(null)
    setErrors({})
    try {
      await apiJson(url, { method: 'POST', body: JSON.stringify({ ...body, idempotencyKey: keyRef.current }) })
      return true
    } catch (err) {
      if (err instanceof ApiError) {
        const issues = fieldIssues(err.details)
        setErrors(issues)
        if (err.code === 'INSUFFICIENT_STOCK') {
          setError(
            err.message ||
              'Not enough sellable stock for this. The movement was not posted.'
          )
        } else {
          setError(
            Object.values(issues)[0] ??
              (err.isForbidden
                ? 'You do not have permission to write stock at this location.'
                : err.message || 'The movement could not be posted.')
          )
        }
      } else {
        setError('Could not reach the server. Press Save again to retry.')
      }
      return false
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return { saving, error, errors, reset, submit, setError }
}

/* -------------------------------- transfer -------------------------------- */

export const TransferModal = ({
  isOpen,
  onClose,
  products,
  pools,
  canWriteLocation,
  onDone,
  initialProductId,
  initialLocation,
}: ActionShellProps) => {
  const [productId, setProductId] = useState('')
  const [fromLocation, setFromLocation] = useState('')
  const [toLocation, setToLocation] = useState('')
  const [quantity, setQuantity] = useState('')
  const [notes, setNotes] = useState('')
  const { saving, error, errors, reset, submit, setError } = useStockSubmit()

  const writable = useMemo(() => locationOptions(canWriteLocation), [canWriteLocation])

  useEffect(() => {
    if (!isOpen) return
    const first = writable[0]?.value ?? ''
    const second = writable[1]?.value ?? first
    setProductId(initialProductId ?? '')
    setFromLocation(initialLocation ?? first)
    setToLocation(first === second ? '' : second)
    setQuantity('')
    setNotes('')
    reset('transfer')
    // `writable` derives from a stable permission callback; re-running on open
    // is exactly what is wanted, so the rest of the inputs stay out of the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  const available = productId ? poolOf(pools, productId, fromLocation).available : 0
  const parsedQuantity = quantity.trim() ? parseQuantity(quantity) : null

  const handleSave = async () => {
    if (!productId) {
      setError('Choose a product first.')
      return
    }
    if (!fromLocation || !toLocation) {
      setError('Choose both locations.')
      return
    }
    if (fromLocation === toLocation) {
      setError('The source and destination must be different.')
      return
    }
    const parsed = parseQuantity(quantity)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    const ok = await submit('/api/stock/transfer', {
      productId,
      quantity: parsed.value,
      fromLocation,
      toLocation,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    })
    if (ok) {
      onDone(
        `${parsed.value} unit${parsed.value === 1 ? '' : 's'} moved to ${
          LOCATION_LABELS[toLocation] ?? toLocation
        }. Purchases and sales were not touched.`
      )
      onClose()
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Transfer between locations"
      description="A transfer moves units from one store to the other. It is not a purchase and not a sale, so no money is recorded."
      size="md"
      dismissible={!saving}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving} disabled={saving || writable.length < 2}>
            Transfer stock
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <ErrorBanner message={error} />}
        {writable.length < 2 && (
          <p className="rounded-md bg-status-warning-bg px-3 py-2 text-sm text-status-warning">
            A transfer writes stock at both ends, so it needs permission for both locations.
            The Founder can record transfers that involve Sheikhupura.
          </p>
        )}
        <Select
          label="Product"
          value={productId}
          error={errors.productId}
          onChange={(e) => setProductId(e.target.value)}
          options={productOptions(products)}
          disabled={saving}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Select
            label="From"
            value={fromLocation}
            error={errors.fromLocation}
            onChange={(e) => setFromLocation(e.target.value)}
            options={writable}
            disabled={saving}
          />
          <Select
            label="To"
            value={toLocation}
            error={errors.toLocation}
            onChange={(e) => setToLocation(e.target.value)}
            options={writable}
            disabled={saving}
          />
        </div>
        {productId && fromLocation && (
          <PoolNote pool={poolOf(pools, productId, fromLocation)} />
        )}
        <Input
          label="Quantity"
          inputMode="numeric"
          value={quantity}
          error={
            errors.quantity ?? (parsedQuantity && !parsedQuantity.ok ? parsedQuantity.error : undefined)
          }
          hint={available > 0 ? `${available} available at the source` : undefined}
          onChange={(e) => setQuantity(e.target.value)}
          disabled={saving}
        />
        <Textarea
          label="Notes"
          rows={2}
          maxLength={2000}
          value={notes}
          error={errors.notes}
          onChange={(e) => setNotes(e.target.value)}
          disabled={saving}
        />
      </div>
    </Modal>
  )
}

/* ------------------------------ physical count ----------------------------- */

export const CountModal = ({
  isOpen,
  onClose,
  products,
  pools,
  canWriteLocation,
  onDone,
  initialProductId,
  initialLocation,
}: ActionShellProps) => {
  const [productId, setProductId] = useState('')
  const [location, setLocation] = useState('')
  const [counted, setCounted] = useState('')
  const [reason, setReason] = useState('')
  const { saving, error, errors, reset, submit, setError } = useStockSubmit()

  const writable = useMemo(() => locationOptions(canWriteLocation), [canWriteLocation])

  useEffect(() => {
    if (!isOpen) return
    setProductId(initialProductId ?? '')
    setLocation(initialLocation ?? writable[0]?.value ?? '')
    setCounted('')
    setReason('')
    reset('count')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  const parsedCount = counted.trim() ? parseCountedQuantity(counted) : null
  const system = productId && location ? poolOf(pools, productId, location).available : 0
  const difference = parsedCount && parsedCount.ok ? parsedCount.value - system : null

  const handleSave = async () => {
    if (!productId) {
      setError('Choose a product first.')
      return
    }
    if (!location) {
      setError('Choose a location.')
      return
    }
    if (!reason.trim()) {
      setError('A reason is required — an adjustment without one cannot be audited.')
      return
    }
    const count = parseCountedQuantity(counted)
    if (!count.ok) {
      setError(count.error)
      return
    }
    const ok = await submit('/api/stock', {
      productId,
      location,
      countedQuantity: count.value,
      reason: reason.trim(),
    })
    if (ok) {
      onDone(
        `Count recorded. An adjustment movement of ${
          count.value === system ? '0' : count.value > system ? `+${count.value - system}` : count.value - system
        } was posted against the ledger.`
      )
      onClose()
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Record a physical count"
      description="Enter what is actually on the shelf. The difference becomes an adjustment movement — the stock figure itself is never edited."
      size="md"
      dismissible={!saving}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving} disabled={saving}>
            Save count
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <ErrorBanner message={error} />}
        <Select
          label="Product"
          value={productId}
          error={errors.productId}
          onChange={(e) => setProductId(e.target.value)}
          options={productOptions(products)}
          disabled={saving}
        />
        <Select
          label="Location"
          value={location}
          error={errors.location}
          onChange={(e) => setLocation(e.target.value)}
          options={writable}
          disabled={saving}
        />
        {productId && location && <PoolNote pool={poolOf(pools, productId, location)} />}
        <Input
          label="Counted quantity"
          inputMode="numeric"
          value={counted}
          error={
            errors.countedQuantity ??
            (parsedCount && !parsedCount.ok ? parsedCount.error : undefined)
          }
          onChange={(e) => setCounted(e.target.value)}
          disabled={saving}
        />
        {difference !== null && difference !== 0 && (
          <p className="text-xs text-ink-secondary">
            This posts an adjustment of <strong>{difference > 0 ? `+${difference}` : difference}</strong>{' '}
            unit{difference === 1 || difference === -1 ? '' : 's'} at{' '}
            {LOCATION_LABELS[location] ?? location}.
          </p>
        )}
        <Textarea
          label="Reason"
          required
          rows={2}
          maxLength={2000}
          placeholder="What the count found — breakage, miscount, unrecorded issue…"
          value={reason}
          error={errors.reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={saving}
        />
      </div>
    </Modal>
  )
}

/* --------------------------- damage / write-off ---------------------------- */

export const DamageModal = ({
  isOpen,
  onClose,
  products,
  pools,
  canWriteLocation,
  onDone,
  initialProductId,
  initialLocation,
}: ActionShellProps) => {
  const [productId, setProductId] = useState('')
  const [location, setLocation] = useState('')
  const [type, setType] = useState<'damage' | 'writeoff'>('damage')
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const { saving, error, errors, reset, submit, setError } = useStockSubmit()

  const writable = useMemo(() => locationOptions(canWriteLocation), [canWriteLocation])
  const parsedQuantity = quantity.trim() ? parseQuantity(quantity) : null

  useEffect(() => {
    if (!isOpen) return
    setProductId(initialProductId ?? '')
    setLocation(initialLocation ?? writable[0]?.value ?? '')
    setType('damage')
    setQuantity('')
    setReason('')
    reset('damage')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  const handleSave = async () => {
    if (!productId) {
      setError('Choose a product first.')
      return
    }
    if (!location) {
      setError('Choose a location.')
      return
    }
    if (!reason.trim()) {
      setError('A reason is required — units do not leave stock without one.')
      return
    }
    const count = parseQuantity(quantity)
    if (!count.ok) {
      setError(count.error)
      return
    }
    const ok = await submit('/api/stock/damage', {
      productId,
      location,
      quantity: count.value,
      type,
      reason: reason.trim(),
    })
    if (ok) {
      onDone(
        type === 'damage'
          ? `${count.value} unit${count.value === 1 ? '' : 's'} moved to damaged stock.`
          : `${count.value} unit${count.value === 1 ? '' : 's'} written off.`
      )
      onClose()
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Damage or write-off"
      description="Units that can no longer be sold leave available stock through a movement, so the ledger still explains every number on screen."
      size="md"
      dismissible={!saving}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving} disabled={saving}>
            Post movement
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <ErrorBanner message={error} />}
        <Select
          label="Product"
          value={productId}
          error={errors.productId}
          onChange={(e) => setProductId(e.target.value)}
          options={productOptions(products)}
          disabled={saving}
        />
        <Select
          label="Location"
          value={location}
          error={errors.location}
          onChange={(e) => setLocation(e.target.value)}
          options={writable}
          disabled={saving}
        />
        {productId && location && <PoolNote pool={poolOf(pools, productId, location)} />}
        <Select
          label="Treatment"
          value={type}
          onChange={(e) => setType(e.target.value as 'damage' | 'writeoff')}
          options={[
            { value: 'damage', label: 'Damaged — kept on the books as unsellable' },
            { value: 'writeoff', label: 'Written off — removed from stock entirely' },
          ]}
          disabled={saving}
        />
        <Input
          label="Quantity"
          inputMode="numeric"
          value={quantity}
          error={
            errors.quantity ?? (parsedQuantity && !parsedQuantity.ok ? parsedQuantity.error : undefined)
          }
          onChange={(e) => setQuantity(e.target.value)}
          disabled={saving}
        />
        <Textarea
          label="Reason"
          required
          rows={2}
          maxLength={2000}
          value={reason}
          error={errors.reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={saving}
        />
      </div>
    </Modal>
  )
}

/* ------------------------------ reverse a row ------------------------------ */

interface ReverseMovementModalProps {
  /** The movement to correct, or null while the dialog is closed. */
  movement: {
    _id: string
    productName?: string
    movementType: string
    quantity: number
    date: string
  } | null
  onClose: () => void
  onReversed: (message: string) => void
}

/**
 * Correction of a posted movement: an appended, linked reversal — never an
 * edit and never a delete (SPEC §3.1.5). The key survives a failed attempt for
 * the same row, so retrying cannot post two reversals.
 */
export const ReverseMovementModal = ({
  movement,
  onClose,
  onReversed,
}: ReverseMovementModalProps) => {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const keyRef = useRef('')

  useEffect(() => {
    if (movement) {
      setReason('')
      setError(null)
      keyRef.current = `rev-${movement._id}-${newIdempotencyKey()}`
    }
  }, [movement])

  if (!movement) return null

  const handleConfirm = async () => {
    if (savingRef.current) return
    if (!reason.trim()) {
      setError('A reason is required.')
      return
    }
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      await apiJson(`/api/stock/movements/${movement._id}/reverse`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim(), idempotencyKey: keyRef.current }),
      })
      onReversed(
        'Reversal posted. The original movement stays in the ledger, marked reversed.'
      )
      onClose()
    } catch (err) {
      if (err instanceof ApiError) {
        const issues = fieldIssues(err.details)
        setError(
          Object.values(issues)[0] ??
            (err.isForbidden
              ? 'You do not have permission to reverse movements.'
              : err.message || 'The reversal could not be posted.')
        )
      } else {
        setError('Could not reach the server. Press Confirm again to retry.')
      }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Reverse this movement?"
      description="A mirror movement is appended and linked to the original. Nothing is deleted, and the correction is audited."
      size="sm"
      dismissible={!saving}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={handleConfirm} loading={saving} disabled={saving}>
            Confirm reversal
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="rounded-md border border-line bg-surface-sunken px-3 py-2.5">
          <p className="text-sm font-medium text-decoricks-dark">
            {movement.productName ?? 'Product'} ·{' '}
            {MOVEMENT_TYPE_LABELS[movement.movementType as keyof typeof MOVEMENT_TYPE_LABELS] ??
              movement.movementType}
          </p>
          <p className="mt-1 text-xs text-ink-muted">
            {movement.quantity} unit{movement.quantity === 1 ? '' : 's'} ·{' '}
            {formatKarachiDate(new Date(movement.date), 'date')}
          </p>
        </div>

        {error && (
          <p role="alert" className="rounded-md bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {error}
          </p>
        )}

        <Textarea
          label="Reason"
          required
          rows={2}
          maxLength={2000}
          placeholder="Why is this movement wrong?"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={saving}
        />
      </div>
    </Modal>
  )
}
