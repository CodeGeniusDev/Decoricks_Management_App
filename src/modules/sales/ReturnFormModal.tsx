'use client'

import React, { useEffect, useRef, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { ApiError, apiJson } from '@/lib/api-client'
import { LOCATION_LABELS } from '@/lib/stock-math'
import { formatPaisa } from '@/lib/money'
import type { AccountView } from '@/modules/finance/finance-ui'
import {
  fieldIssues,
  karachiToday,
  newIdempotencyKey,
  paisaToInputValue,
  parseOptionalPkrAmount,
  parseQuantity,
} from '@/lib/form-helpers'
import {
  RETURN_OUTCOME_LABELS,
  returnOutcomes,
  type OrderView,
  type ReturnOutcome,
  type ReturnView,
} from './sales-ui'

interface ReturnFormModalProps {
  isOpen: boolean
  onClose: () => void
  /** The delivered or returned order the parcel came back from. */
  order: OrderView
  /** Every return already recorded against this order — the remaining quantities come from here. */
  existingReturns: ReturnView[]
  accounts: AccountView[]
  isFounder: boolean
  onSaved: (created: ReturnView, updatedOrder: OrderView | null, replayed: boolean) => void
}

interface ReturnLine {
  productId: string
  productName: string
  /** Units the order took out and no previous return has taken back yet. */
  remaining: number
  quantity: string
  reason: string
}

/**
 * ReturnFormModal — bring a delivered parcel back into the books.
 *
 * One submission produces, in a single server-side transaction:
 *
 *   - a stock movement per returned unit, into the pool the outcome chooses
 *     (`restock` → available again, the SPEC default; `damaged` → damaged pool;
 *     `writeoff` → gone, shown only as returned);
 *   - a `refunds_return_costs` ledger expense for the refund, which NETS sales
 *     rather than being hidden from the P&L;
 *   - the same category for return courier costs, because a round trip that
 *     failed still cost real money.
 *
 * The units that can still come back are computed from the order minus every
 * previous return, so a second partial return cannot restock more than was ever
 * sold — nothing is counted twice. The customer's own money is never assumed:
 * the refund starts empty and the API caps it at the order total.
 *
 * Damaging or writing off returned goods is a Founder decision (SPEC §5.5), so
 * Partners see restock only. The server enforces that independently; this form
 * just avoids offering a choice that would be refused.
 */
export const ReturnFormModal = ({
  isOpen,
  onClose,
  order,
  existingReturns,
  accounts,
  isFounder,
  onSaved,
}: ReturnFormModalProps) => {
  const [lines, setLines] = useState<ReturnLine[]>([])
  const [outcome, setOutcome] = useState<ReturnOutcome>('restock')
  const [refund, setRefund] = useState('')
  const [courierCost, setCourierCost] = useState('')
  const [date, setDate] = useState(karachiToday)
  const [accountId, setAccountId] = useState('')
  const [notes, setNotes] = useState('')

  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const keyRef = useRef('')

  /**
   * Units already returned per product, across every previous return record.
   * Read when the dialog opens, not on every render: a background refetch of
   * `existingReturns` must not reset a form the user is halfway through typing.
   */
  const returnedByProduct = (records: ReturnView[]): Map<string, number> => {
    const map = new Map<string, number>()
    for (const record of records) {
      for (const item of record.items) {
        map.set(item.productId, (map.get(item.productId) ?? 0) + item.quantity)
      }
    }
    return map
  }

  useEffect(() => {
    if (!isOpen) return
    const returnedSoFar = returnedByProduct(existingReturns)
    setLines(
      order.items.map((item) => ({
        productId: item.productId,
        productName: item.productName,
        remaining: item.quantity - (returnedSoFar.get(item.productId) ?? 0),
        quantity: '',
        reason: '',
      }))
    )
    setOutcome('restock')
    setRefund('')
    setCourierCost('')
    setDate(karachiToday())
    setAccountId('')
    setNotes('')
    setErrors({})
    setFormError(null)
    keyRef.current = `return-${order._id}-${newIdempotencyKey()}`
    // Intentionally keyed on the dialog opening: the returned figures are a
    // snapshot for this session, and re-seeding mid-edit would lose input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, order._id])

  const returnable = lines.filter((line) => line.remaining > 0)
  const refundPaisa = parseOptionalPkrAmount(refund)
  const courierPaisa = parseOptionalPkrAmount(courierCost)

  /**
   * Lines the user put a number on, already parsed. `validate` returns the same
   * array it checked, so the quantities that pass the "still returnable" bound
   * are exactly the quantities that reach the API — no second parse that could
   * diverge from what the fields showed.
   */
  type SelectedLine = { productId: string; quantity: number; reason: string }

  const parseSelected = (): { ok: true; items: SelectedLine[] } | { ok: false } => {
    const next: Record<string, string> = {}
    const items: SelectedLine[] = []
    lines.forEach((line, index) => {
      if (!line.quantity.trim()) return
      const parsed = parseQuantity(line.quantity)
      if (!parsed.ok) {
        next[`items.${index}.quantity`] = parsed.error
      } else if (parsed.value > line.remaining) {
        next[`items.${index}.quantity`] = `Only ${line.remaining} can still be returned`
      } else {
        items.push({ productId: line.productId, quantity: parsed.value, reason: line.reason.trim() })
      }
      if (!line.reason.trim()) next[`items.${index}.reason`] = 'A reason is required'
    })
    if (Object.keys(next).length > 0) {
      setErrors(next)
      return { ok: false }
    }
    return { ok: true, items }
  }

  const patchLine = (productId: string, changes: Partial<ReturnLine>) =>
    setLines((current) =>
      current.map((line) => (line.productId === productId ? { ...line, ...changes } : line))
    )

  const validate = (): { ok: true; items: SelectedLine[] } | { ok: false } => {
    if (returnable.length === 0) {
      setErrors({
        items: 'Every unit on this order has already been returned.',
      })
      return { ok: false }
    }

    const parsed = parseSelected()
    if (!parsed.ok) return { ok: false }
    if (parsed.items.length === 0) {
      setErrors({ items: 'Enter a quantity for at least one item.' })
      return { ok: false }
    }

    const next: Record<string, string> = {}
    if (!refundPaisa.ok) next.refundAmount = refundPaisa.error
    else if ((refundPaisa.paisa ?? 0) > order.total) {
      next.refundAmount = `Maximum refund is ${formatPaisa(order.total)} (the order total)`
    }
    if (!courierPaisa.ok) next.courierCost = courierPaisa.error
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) next.date = 'Choose the return date'

    if (Object.keys(next).length > 0) {
      setErrors(next)
      return { ok: false }
    }
    return { ok: true, items: parsed.items }
  }

  const handleSave = async () => {
    if (savingRef.current) return
    const valid = validate()
    if (!valid.ok) return

    savingRef.current = true
    setSaving(true)
    setFormError(null)

    try {
      const result = await apiJson<{ return: ReturnView; order?: OrderView; replay?: boolean }>(
        '/api/returns',
        {
          method: 'POST',
          body: JSON.stringify({
            orderId: order._id,
            items: valid.items.map((item) => ({
              ...item,
              ...(isFounder && outcome !== 'restock' ? { outcome } : {}),
            })),
            outcome,
            refundAmount: refundPaisa.ok ? (refundPaisa.paisa ?? 0) : 0,
            ...(courierPaisa.ok && courierPaisa.paisa ? { courierCost: courierPaisa.paisa } : {}),
            ...(accountId ? { accountId } : {}),
            date,
            ...(notes.trim() ? { notes: notes.trim() } : {}),
            idempotencyKey: keyRef.current,
          }),
        }
      )
      onSaved(result.return, result.order ?? null, Boolean(result.replay))
      onClose()
    } catch (err) {
      if (err instanceof ApiError) {
        const issues = fieldIssues(err.details)
        setErrors(issues)
        setFormError(
          Object.values(issues)[0] ??
            (err.isForbidden
              ? 'You do not have permission to return stock into that location.'
              : err.message || 'The return could not be recorded.')
        )
      } else {
        setFormError(
          'Could not reach the server. Press Record return again — the retry will not create a second return.'
        )
      }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const outcomeOptions = returnOutcomes(isFounder).map((value) => ({
    value,
    label: RETURN_OUTCOME_LABELS[value],
  }))

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Return ${order.orderNumber}`}
      description="Returned units become stock movements, and the refund becomes a ledger entry that nets sales — in one action."
      size="lg"
      dismissible={!saving}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving} disabled={saving || returnable.length === 0}>
            Record return
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

        {returnable.length === 0 ? (
          <p className="rounded-md bg-status-warning-bg px-3 py-2 text-sm text-status-warning">
            Every unit on this order has already been returned. Nothing is left to bring back.
          </p>
        ) : (
          <>
            <div>
              <p className="text-xs font-medium text-ink-secondary">
                Items · shipping from{' '}
                {order.shipFromLocation
                  ? LOCATION_LABELS[order.shipFromLocation] ?? order.shipFromLocation
                  : 'the order location'}
              </p>
              <ul className="mt-2 flex flex-col gap-3">
                {lines.map((line, index) => (
                  <li
                    key={line.productId}
                    className="rounded-md border border-line-subtle bg-surface-sunken p-3"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="text-sm font-medium text-decoricks-dark">{line.productName}</p>
                      <p className="text-xs text-ink-muted">{line.remaining} still returnable</p>
                    </div>
                    {line.remaining <= 0 ? (
                      <p className="mt-1 text-xs text-ink-muted">Fully returned already</p>
                    ) : (
                      <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-[120px_1fr]">
                        <Input
                          label="Qty"
                          inputMode="numeric"
                          value={line.quantity}
                          error={errors[`items.${index}.quantity`]}
                          onChange={(e) => patchLine(line.productId, { quantity: e.target.value })}
                          disabled={saving}
                        />
                        <Input
                          label="Reason"
                          placeholder="Damaged in transit, wrong item, customer changed mind…"
                          value={line.reason}
                          error={errors[`items.${index}.reason`]}
                          onChange={(e) => patchLine(line.productId, { reason: e.target.value })}
                          disabled={saving}
                        />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {errors.items && (
                <p role="alert" className="mt-2 text-sm text-status-danger">
                  {errors.items}
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {isFounder ? (
                <Select
                  label="Return stock as"
                  value={outcome}
                  error={errors.outcome}
                  onChange={(e) => setOutcome(e.target.value as ReturnOutcome)}
                  options={outcomeOptions}
                  disabled={saving}
                />
              ) : (
                <Input
                  label="Return stock as"
                  value={RETURN_OUTCOME_LABELS.restock}
                  readOnly
                  hint="Only the Founder can mark returned goods damaged or write them off."
                  onChange={() => {}}
                />
              )}
              <Input
                label="Refund to customer (PKR)"
                inputMode="decimal"
                placeholder="0"
                value={refund}
                error={errors.refundAmount}
                hint={`Charged on this order: ${formatPaisa(order.total)}`}
                onChange={(e) => setRefund(e.target.value)}
                disabled={saving}
              />
              <Input
                label="Return courier cost (PKR)"
                inputMode="decimal"
                placeholder="0"
                value={courierCost}
                error={errors.courierCost}
                hint="Posted as an expense — a round trip that failed still cost money."
                onChange={(e) => setCourierCost(e.target.value)}
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
                label="Settle through account"
                value={accountId}
                error={errors.accountId}
                onChange={(e) => setAccountId(e.target.value)}
                options={[
                  { value: '', label: 'Automatic (business posting accounts)' },
                  ...accounts.map((item) => ({ value: item._id, label: item.name })),
                ]}
                disabled={saving}
              />
              <div className="flex items-end">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRefund(paisaToInputValue(order.total))}
                  disabled={
                    saving || (refundPaisa.ok && (refundPaisa.paisa ?? 0) >= order.total)
                  }
                >
                  Refund the full order total
                </Button>
              </div>
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
          </>
        )}
      </div>
    </Modal>
  )
}
