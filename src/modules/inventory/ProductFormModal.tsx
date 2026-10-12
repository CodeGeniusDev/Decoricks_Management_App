'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Checkbox } from '@/components/ui/Checkbox'
import { ApiError, apiJson } from '@/lib/api-client'
import { formatPaisa } from '@/lib/money'
import {
  fieldIssues,
  newIdempotencyKey,
  paisaToInputValue,
  parseOptionalPkrAmount,
  parsePkrAmount,
} from '@/lib/form-helpers'
import type { ProductVariantView, ProductView } from './inventory-ui'

interface ProductFormModalProps {
  isOpen: boolean
  onClose: () => void
  /** Null for a create; the stored product for an edit. */
  product: ProductView | null
  /** Existing categories, offered as suggestions only — free text is allowed. */
  categories: string[]
  onSaved: (product: ProductView, created: boolean) => void
}

interface VariantRow {
  id: string
  name: string
  sku: string
  sellingPrice: string
}

interface FormState {
  sku: string
  name: string
  description: string
  category: string
  cost: string
  sellingPrice: string
  reorderLevel: string
  isActive: boolean
  variants: VariantRow[]
}

const emptyForm = (): FormState => ({
  sku: '',
  name: '',
  description: '',
  category: '',
  cost: '',
  sellingPrice: '',
  reorderLevel: '',
  isActive: true,
  variants: [],
})

const seedForm = (product: ProductView): FormState => ({
  sku: product.sku,
  name: product.name,
  description: product.description ?? '',
  category: product.category,
  cost: paisaToInputValue(product.cost),
  sellingPrice: paisaToInputValue(product.sellingPrice),
  reorderLevel: product.reorderLevel != null ? String(product.reorderLevel) : '',
  isActive: product.isActive,
  variants: (product.variants ?? []).map((variant) => ({
    id: `v-${variant.name}-${variant.sku ?? ''}`,
    name: variant.name,
    sku: variant.sku ?? '',
    sellingPrice: variant.sellingPrice != null ? paisaToInputValue(variant.sellingPrice) : '',
  })),
})

const newRow = (): VariantRow => ({ id: newIdempotencyKey(), name: '', sku: '', sellingPrice: '' })

/**
 * ProductFormModal — create or edit one product listing.
 *
 * Three deliberate limits, both from SPEC §5.1 and from the brief's "I enter
 * all data myself" rule:
 *
 *  1. Category is free text. Nothing here suggests a taxonomy the business has
 *     not defined itself; the datalist only offers categories that already
 *     exist in the database.
 *  2. Weighted average cost is read-only after creation. Purchases move it
 *     (SPEC §5.3); letting this form type it would silently rewrite the basis of
 *     every future COGS figure with no movement in the ledger to explain it.
 *     The opening cost is entered once, at creation, before any purchase exists.
 *  3. No delete. Closing a listing archives it (`isActive: false`) so the
 *     movement ledger keeps resolving every past order line.
 *
 * The idempotency key is minted when the modal opens and kept across failed
 * attempts, so a retry after a timeout replays the original instead of
 * creating a second product.
 */
export const ProductFormModal = ({
  isOpen,
  onClose,
  product,
  categories,
  onSaved,
}: ProductFormModalProps) => {
  const isEdit = Boolean(product)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const idempotencyKeyRef = useRef<string>('')

  useEffect(() => {
    if (!isOpen) return
    setForm(product ? seedForm(product) : emptyForm())
    setErrors({})
    setFormError(null)
    idempotencyKeyRef.current = `product-${product?._id ?? 'new'}-${newIdempotencyKey()}`
  }, [isOpen, product])

  const patch = (changes: Partial<FormState>) => setForm((current) => ({ ...current, ...changes }))

  const patchVariant = (id: string, changes: Partial<VariantRow>) =>
    setForm((current) => ({
      ...current,
      variants: current.variants.map((row) => (row.id === id ? { ...row, ...changes } : row)),
    }))

  const sellingPaisa = useMemo(() => parsePkrAmount(form.sellingPrice), [form.sellingPrice])

  const validate = (): boolean => {
    const next: Record<string, string> = {}
    if (!form.sku.trim()) next.sku = 'SKU is required'
    if (!form.name.trim()) next.name = 'Name is required'
    if (!form.category.trim()) next.category = 'Category is required'

    if (!isEdit) {
      const cost = parseOptionalPkrAmount(form.cost)
      if (!cost.ok) next.cost = cost.error
      else if (cost.paisa !== null && cost.paisa < 0) next.cost = 'Cost cannot be negative'
    }

    if (!sellingPaisa.ok) next.sellingPrice = sellingPaisa.error

    if (form.reorderLevel.trim()) {
      const value = Number(form.reorderLevel.trim())
      if (!Number.isInteger(value) || value < 0) {
        next.reorderLevel = 'Enter a whole number of units, 0 or more'
      }
    }

    const seenVariants = new Set<string>()
    form.variants.forEach((row, index) => {
      const name = row.name.trim()
      if (!name) {
        next[`variant.${index}.name`] = 'Variant name is required'
      } else if (seenVariants.has(name.toLowerCase())) {
        next[`variant.${index}.name`] = 'This variant is already listed'
      } else {
        seenVariants.add(name.toLowerCase())
      }
      if (row.sellingPrice.trim()) {
        const price = parsePkrAmount(row.sellingPrice)
        if (!price.ok) next[`variant.${index}.sellingPrice`] = price.error
      }
    })

    setErrors(next)
    return Object.keys(next).length === 0
  }

  const buildPayload = (): Record<string, unknown> => {
    const variants: ProductVariantView[] = []
    for (const row of form.variants) {
      const name = row.name.trim()
      if (!name) continue
      const variant: ProductVariantView = { name }
      if (row.sku.trim()) variant.sku = row.sku.trim()
      if (row.sellingPrice.trim()) {
        const price = parsePkrAmount(row.sellingPrice)
        if (price.ok) variant.sellingPrice = price.paisa
      }
      variants.push(variant)
    }

    const body: Record<string, unknown> = {
      sku: form.sku.trim(),
      name: form.name.trim(),
      category: form.category.trim(),
      sellingPrice: sellingPaisa.ok ? sellingPaisa.paisa : 0,
      isActive: form.isActive,
    }
    if (form.description.trim()) body.description = form.description.trim()
    if (form.reorderLevel.trim()) body.reorderLevel = Number(form.reorderLevel.trim())
    if (variants.length > 0) body.variants = variants

    if (!isEdit) {
      const cost = parseOptionalPkrAmount(form.cost)
      body.cost = cost.ok && cost.paisa !== null ? cost.paisa : 0
      body.idempotencyKey = idempotencyKeyRef.current
    }
    return body
  }

  const handleSubmit = async () => {
    if (savingRef.current) return
    if (!validate()) return

    savingRef.current = true
    setSaving(true)
    setFormError(null)

    try {
      const saved = await apiJson<ProductView>(
        isEdit ? `/api/products/${product!._id}` : '/api/products',
        { method: isEdit ? 'PUT' : 'POST', body: JSON.stringify(buildPayload()) }
      )
      onSaved(saved, !isEdit)
      onClose()
    } catch (err) {
      if (err instanceof ApiError) {
        const issues = fieldIssues(err.details)
        setErrors(issues)
        setFormError(
          Object.values(issues)[0] ??
            (err.isForbidden
              ? 'You do not have permission to save products.'
              : err.message || 'Could not save the product.')
        )
      } else {
        setFormError('Could not reach the server. Press Save again to retry.')
      }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const listId = 'product-category-suggestions'

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEdit ? `Edit ${product?.name}` : 'New product'}
      description="Prices are stored in paisa and shown as PKR. Stock is never typed here — it comes from purchases, sales and movements."
      size="lg"
      dismissible={!saving}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={saving} disabled={saving}>
            {isEdit ? 'Save changes' : 'Create product'}
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

        <datalist id={listId}>
          {categories.map((category) => (
            <option key={category} value={category} />
          ))}
        </datalist>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="SKU"
            required
            maxLength={64}
            value={form.sku}
            error={errors.sku}
            onChange={(e) => patch({ sku: e.target.value })}
            disabled={saving}
          />
          <Input
            label="Name"
            required
            maxLength={200}
            value={form.name}
            error={errors.name}
            onChange={(e) => patch({ name: e.target.value })}
            disabled={saving}
          />
          <Input
            label="Category"
            required
            maxLength={100}
            list={listId}
            placeholder="As you call it in the business"
            value={form.category}
            error={errors.category}
            onChange={(e) => patch({ category: e.target.value })}
            disabled={saving}
          />
          <Input
            label="Selling price (PKR)"
            required
            inputMode="decimal"
            value={form.sellingPrice}
            error={errors.sellingPrice}
            onChange={(e) => patch({ sellingPrice: e.target.value })}
            disabled={saving}
          />
          <Input
            label={isEdit ? 'Weighted average cost' : 'Opening cost (PKR)'}
            inputMode={isEdit ? undefined : 'decimal'}
            readOnly={isEdit}
            value={form.cost}
            error={errors.cost}
            onChange={(e) => patch({ cost: e.target.value })}
            disabled={saving}
          />
          <Input
            label="Reorder level (units)"
            inputMode="numeric"
            placeholder="Optional"
            value={form.reorderLevel}
            error={errors.reorderLevel}
            onChange={(e) => patch({ reorderLevel: e.target.value })}
            disabled={saving}
          />
        </div>

        {isEdit && (
          <p className="-mt-1 text-xs text-ink-muted">
            Weighted average cost is {formatPaisa(product?.cost ?? 0)} and is updated by purchases,
            not by this form. Corrections belong in the stock movement ledger.
          </p>
        )}

        <Textarea
          label="Description"
          rows={3}
          maxLength={2000}
          value={form.description}
          error={errors.description}
          onChange={(e) => patch({ description: e.target.value })}
          disabled={saving}
        />

        <div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-medium text-ink-secondary">Variants</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => patch({ variants: [...form.variants, newRow()] })}
              disabled={saving}
            >
              Add variant
            </Button>
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            Sizes, colours or fabrics of the same product. They share one stock pool; a price here
            overrides the product price for that variant only.
          </p>

          {form.variants.length > 0 && (
            <ul className="mt-3 flex flex-col gap-3">
              {form.variants.map((row, index) => (
                <li
                  key={row.id}
                  className="rounded-md border border-line-subtle bg-surface-sunken p-3"
                >
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <Input
                      label="Variant"
                      value={row.name}
                      error={errors[`variant.${index}.name`]}
                      onChange={(e) => patchVariant(row.id, { name: e.target.value })}
                      disabled={saving}
                    />
                    <Input
                      label="Variant SKU"
                      value={row.sku}
                      onChange={(e) => patchVariant(row.id, { sku: e.target.value })}
                      disabled={saving}
                    />
                    <Input
                      label="Price override (PKR)"
                      inputMode="decimal"
                      value={row.sellingPrice}
                      error={errors[`variant.${index}.sellingPrice`]}
                      onChange={(e) => patchVariant(row.id, { sellingPrice: e.target.value })}
                      disabled={saving}
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2"
                    onClick={() =>
                      patch({ variants: form.variants.filter((item) => item.id !== row.id) })
                    }
                    disabled={saving}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <Checkbox
          label="Active listing"
          checked={form.isActive}
          onChange={(e) => patch({ isActive: e.target.checked })}
          disabled={saving || !isEdit}
        />
        {!isEdit && (
          <p className="-mt-3 text-xs text-ink-muted">
            New products are always active. Closing a listing is done from the product row.
          </p>
        )}
      </div>
    </Modal>
  )
}
