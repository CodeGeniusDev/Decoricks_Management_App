'use client'

import { IconClose, IconPlus } from '@/components/ui/icons'

import { useState, useEffect, useRef } from 'react'
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
import { useFinanceData, FinancialEntry } from '@/hooks/useFinanceData'
import { formatPaisa, pkrToPaisa } from '@/lib/money'
import { getKarachiDate } from '@/lib/date'
import { apiFetch } from '@/lib/api-client'

type EntryType = 'income' | 'expense' | 'transfer'

interface FormErrors {
  amount?: string
  category?: string
  source?: string
  fromAccount?: string
  toAccount?: string
  description?: string
  date?: string
  general?: string
}

const EXPENSE_CATEGORIES = [
  'meta_ads',
  'shopify_subscription',
  'flyers_printing',
  'product_purchasing',
  'shipping_courier',
  'packaging',
  'refunds_return_costs',
  'platform_fees',
  'content_production',
  'miscellaneous',
]

const INCOME_CATEGORIES = ['sales', 'other']
const INCOME_SOURCES = ['cod', 'bank_transfer', 'cash', 'jazzcash', 'other']
const TRANSFER_ACCOUNTS = ['cash', 'bank_account', 'jazzcash_wallet', 'other']

const FIELD_ERROR_KEYS: Array<keyof FormErrors> = [
  'amount',
  'category',
  'source',
  'fromAccount',
  'toAccount',
  'description',
  'date',
]

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Turn a server validation payload into per-field messages so the user sees the
 * error next to the input that caused it. Falls back to a single general message.
 */
function mapServerFieldErrors(details: unknown, fallback: string): FormErrors {
  const list = Array.isArray(details) ? details : []

  if (list.length === 0) {
    return { general: fallback }
  }

  const fieldErrors: FormErrors = {}

  for (const item of list) {
    const path = typeof item?.path === 'string' ? item.path.split('.')[0] : ''
    const message = typeof item?.message === 'string' ? item.message : fallback

    if (FIELD_ERROR_KEYS.includes(path as keyof FormErrors)) {
      fieldErrors[path as keyof FormErrors] = message
    } else if (!fieldErrors.general) {
      fieldErrors.general = message
    }
  }

  return Object.keys(fieldErrors).length > 0 ? fieldErrors : { general: fallback }
}

export default function FinancePage() {
  const {
    data,
    income,
    expenses,
    transfers,
    summary,
    summaryError,
    loading,
    error,
    refetch,
  } = useFinanceData()

  const [activeTab, setActiveTab] = useState<'income' | 'expenses' | 'transfers'>('income')
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [entryType, setEntryType] = useState<EntryType>('income')
  const [editingEntry, setEditingEntry] = useState<FinancialEntry | null>(null)

  // Form state preserved across tab switches
  const [formAmount, setFormAmount] = useState('')
  const [formCategory, setFormCategory] = useState('sales')
  const [formSource, setFormSource] = useState('cod')
  const [formFromAccount, setFormFromAccount] = useState('cash')
  const [formToAccount, setFormToAccount] = useState('bank_account')
  const [formDescription, setFormDescription] = useState('')
  const [formDate, setFormDate] = useState('')
  const [formErrors, setFormErrors] = useState<FormErrors>({})
  const [isSubmitting, setIsSubmitting] = useState(false)
const isSubmittingRef = useRef(false)
const submitRequestIdRef = useRef<string>(createRequestId())
  const [toastMessage, setToastMessage] = useState<{ type: 'success' | 'error' | 'info' | 'warning'; message: string } | null>(null)

  useEffect(() => {
    // Initialize form date with today's date in Karachi timezone
    if (!formDate) {
      const today = getKarachiDate()
      const dateStr = today.toISOString().split('T')[0]
      setFormDate(dateStr)
    }
  }, [formDate])

  const resetForm = () => {
    setFormAmount('')
    setFormCategory('sales')
    setFormSource('cod')
    setFormFromAccount('cash')
    setFormToAccount('bank_account')
    setFormDescription('')
    setFormErrors({})
    setEditingEntry(null)
  }

  const openModal = (type: EntryType) => {
    setEntryType(type)
    resetForm()
    setIsModalOpen(true)
  }

  const openEditModal = (entry: FinancialEntry, type: EntryType) => {
    setEntryType(type)
    setEditingEntry(entry)
    setFormAmount(formatPaisaInput(entry.amount))
    setFormCategory(entry.category)
    setFormSource(entry.source)
    setFormDescription(entry.description || '')
    setFormDate(new Date(entry.date).toISOString().split('T')[0])
    setFormErrors({})
    setIsModalOpen(true)
  }

  const closeModal = () => {
    setIsModalOpen(false)
    resetForm()
  }

  const formatPaisaInput = (paisa: number): string => {
    // Convert paisa to PKR for input display
    return (paisa / 100).toFixed(2)
  }

  const validateForm = (): FormErrors => {
    const errors: FormErrors = {}
    const amount = parseFloat(formAmount)

    if (!formAmount || isNaN(amount) || amount <= 0) {
      errors.amount = 'Please enter a valid positive amount'
    }
    if (!formCategory) {
      errors.category = 'Please select a category'
    }
    if (entryType === 'income' && !formSource) {
      errors.source = 'Please select a source'
    }
    if (entryType === 'transfer') {
      if (!formFromAccount) errors.fromAccount = 'Please select from account'
      if (!formToAccount) errors.toAccount = 'Please select to account'
      if (formFromAccount === formToAccount) {
        errors.fromAccount = 'From and to accounts must be different'
      }
    }
    if (!formDate) {
      errors.general = 'Please select a date'
    }

    return errors
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    // Hard guard against double submits (double click / Enter twice): React state
    // is not applied synchronously, so `isSubmitting` alone is not enough.
    if (isSubmittingRef.current) return

    const errors = validateForm()
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors)
      return
    }

    isSubmittingRef.current = true
    setIsSubmitting(true)

    try {
      const amount = pkrToPaisa(parseFloat(formAmount))
      const payload = {
        type: entryType,
        amount,
        category: entryType === 'income' ? formCategory : entryType === 'expense' ? formCategory : undefined,
        source: entryType === 'income' ? formSource : undefined,
        fromAccount: entryType === 'transfer' ? formFromAccount : undefined,
        toAccount: entryType === 'transfer' ? formToAccount : undefined,
        description: formDescription || undefined,
        date: new Date(formDate).toISOString(),
      }

      const isEdit = Boolean(editingEntry)
      const url = isEdit ? `/api/finance/${entryType}/${editingEntry!._id}` : '/api/finance'
      const method = isEdit ? 'PUT' : 'POST'

      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          // Idempotency key: a retried/duplicated POST returns the original
          // record instead of writing a second financial entry.
          ...(isEdit ? {} : { clientRequestId: submitRequestIdRef.current }),
        }),
      })

      const result = await res.json().catch(() => null)

      if (!result || result.success !== true) {
        const errorMsg = result?.error?.message || `Request failed (${res.status})`
        setFormErrors(mapServerFieldErrors(result?.error?.details, errorMsg))
        setToastMessage({ type: 'error', message: errorMsg })
        // Form values are intentionally left untouched so nothing typed is lost.
        return
      }

      // Only clear the form once the server has confirmed the write.
      closeModal()
      setToastMessage({
        type: 'success',
        message: isEdit ? `${entryType} updated successfully` : `${entryType} added successfully`,
      })
      // Rotate the idempotency key so the next entry is a genuinely new record.
      submitRequestIdRef.current = createRequestId()
      await refetch()
    } catch (err) {
      setFormErrors({ general: err instanceof Error ? err.message : 'Network error' })
      setToastMessage({ type: 'error', message: 'Network error. Please try again.' })
    } finally {
      isSubmittingRef.current = false
      setIsSubmitting(false)
    }
  }

  const handleDelete = async (entry: FinancialEntry, type: EntryType) => {
    if (!confirm(`Are you sure you want to delete this ${type} entry?`)) return

    try {
      const res = await apiFetch(`/api/finance/${type}/${entry._id}`, { method: 'DELETE' })
      const result = await res.json()

      if (result.success) {
        setToastMessage({ type: 'success', message: `${type} entry deleted` })
        refetch()
      } else {
        setToastMessage({ type: 'error', message: result.error?.message || 'Delete failed' })
      }
    } catch (err) {
      setToastMessage({ type: 'error', message: 'Network error' })
    }
  }

  const getCategoryOptions = () => {
    if (entryType === 'income') return INCOME_CATEGORIES.map((c) => ({ value: c, label: c }))
    if (entryType === 'expense') return EXPENSE_CATEGORIES.map((c) => ({ value: c, label: c }))
    return [{ value: 'transfer', label: 'transfer' }]
  }

  const getSourceOptions = () => {
    return INCOME_SOURCES.map((s) => ({ value: s, label: s }))
  }

  const accountOptions = TRANSFER_ACCOUNTS.map((a) => ({ value: a, label: a }))

  const currentItems = activeTab === 'income' ? income : activeTab === 'expenses' ? expenses : transfers
  const columns =
    activeTab === 'income'
      ? [
          { key: 'amountDisplay', label: 'Amount' },
          { key: 'category', label: 'Category' },
          { key: 'source', label: 'Source' },
          { key: 'date', label: 'Date' },
          { key: 'actions', label: 'Actions' },
        ]
      : activeTab === 'expenses'
      ? [
          { key: 'amountDisplay', label: 'Amount' },
          { key: 'category', label: 'Category' },
          { key: 'description', label: 'Description' },
          { key: 'date', label: 'Date' },
          { key: 'actions', label: 'Actions' },
        ]
      : [
          { key: 'amountDisplay', label: 'Amount' },
          { key: 'fromAccount', label: 'From' },
          { key: 'toAccount', label: 'To' },
          { key: 'date', label: 'Date' },
          { key: 'actions', label: 'Actions' },
        ]

  const tableData = currentItems.map((entry) => ({
    ...entry,
    actions: (
      <div className="flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => openEditModal(entry, activeTab === 'income' ? 'income' : activeTab === 'expenses' ? 'expense' : 'transfer')}
        >
          Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            handleDelete(
              entry,
              activeTab === 'income' ? 'income' : activeTab === 'expenses' ? 'expense' : 'transfer'
            )
          }
        >
          Delete
        </Button>
      </div>
    ),
  }))

  if (loading) {
    return (
      <PageTransition>
        <h1 className="text-2xl font-bold text-decoricks-dark mb-6">Finance</h1>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
          <Skeleton variant="rect" className="h-24" />
          <Skeleton variant="rect" className="h-24" />
          <Skeleton variant="rect" className="h-24" />
        </div>
        <Skeleton variant="rect" className="h-96 mb-6" />
      </PageTransition>
    )
  }

  return (
    <PageTransition>
      <h1 className="text-2xl font-bold text-decoricks-dark mb-6">Finance</h1>

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

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          <Card animate={false} className="p-6 text-center">
            <p className="text-sm text-decoricks-dark/60 mb-2">MTD Income</p>
            <p className="text-2xl font-bold text-green-600">{summary.mtdIncomeDisplay}</p>
          </Card>
          <Card animate={false} className="p-6 text-center">
            <p className="text-sm text-decoricks-dark/60 mb-2">MTD Expenses</p>
            <p className="text-2xl font-bold text-red-500">{summary.mtdExpensesDisplay}</p>
          </Card>
          <Card animate={false} className="p-6 text-center">
            <p className="text-sm text-decoricks-dark/60 mb-2">Net Cash Flow</p>
            <p
              className={`text-2xl font-bold ${
                summary.netCashFlow >= 0 ? 'text-green-600' : 'text-red-500'
              }`}
            >
              {summary.netCashFlowDisplay}
            </p>
          </Card>
        </div>
      )}

      {/* Error display */}
      {error && !data && (
        <Card className="p-6 mb-6 border-red-200">
          <p className="text-red-600">Failed to load finance data: {error}</p>
          <Button variant="outline" size="sm" onClick={refetch} className="mt-2">
            Retry
          </Button>
        </Card>
      )}

      {/* The table can still be usable when only the summary failed, so this is
          reported separately rather than blanking the page or showing a
          fabricated all-zero summary. */}
      {summaryError && (
        <Card variant="default" className="p-4 mb-6 border-amber-200">
          <p className="text-sm text-amber-800">
            Could not load the month-to-date summary: {summaryError}
          </p>
          <Button variant="outline" size="sm" onClick={refetch} className="mt-2">
            Retry summary
          </Button>
        </Card>
      )}

      {/* Tabs + Add Button */}
      <Card className="mb-6">
        <div className="flex items-center justify-between p-4 border-b border-decoricks-black/10">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setActiveTab('income')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === 'income'
                  ? 'bg-decoricks-brown text-decoricks-light'
                  : 'text-decoricks-dark hover:bg-decoricks-dark/10'
              }`}
            >
              Income
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('expenses')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === 'expenses'
                  ? 'bg-decoricks-brown text-decoricks-light'
                  : 'text-decoricks-dark hover:bg-decoricks-dark/10'
              }`}
            >
              Expenses
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('transfers')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === 'transfers'
                  ? 'bg-decoricks-brown text-decoricks-light'
                  : 'text-decoricks-dark hover:bg-decoricks-dark/10'
              }`}
            >
              Transfers
            </button>
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={() => openModal(activeTab === 'income' ? 'income' : activeTab === 'expenses' ? 'expense' : 'transfer')}
          >
            <IconPlus size={16}  />
            Add {activeTab === 'income' ? 'Income' : activeTab === 'expenses' ? 'Expense' : 'Transfer'}
          </Button>
        </div>

        {/* Table */}
        <div className="p-4">
          {currentItems.length === 0 ? (
            <EmptyState
              title="No entries found"
              description={`No ${activeTab} entries have been recorded yet.`}
              action={{
                label: `Add ${activeTab === 'income' ? 'Income' : activeTab === 'expenses' ? 'Expense' : 'Transfer'}`,
                onClick: () =>
                  openModal(
                    activeTab === 'income'
                      ? 'income'
                      : activeTab === 'expenses'
                      ? 'expense'
                      : 'transfer'
                  ),
              }}
            />
          ) : (
            <Table columns={columns} data={tableData} />
          )}
        </div>
      </Card>

      {/* Add/Edit Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={closeModal}
        title={editingEntry ? 'Edit Entry' : `Add ${entryType === 'income' ? 'Income' : entryType === 'expense' ? 'Expense' : 'Transfer'}`}
        size="lg"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Entry Type Selector (when not editing) */}
          {!editingEntry && (
            <div className="flex gap-2 mb-4">
              {(['income', 'expense', 'transfer'] as EntryType[]).map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => {
                    setEntryType(type)
                    setFormCategory(type === 'income' ? 'sales' : type === 'expense' ? 'miscellaneous' : 'transfer')
                    setFormSource('cod')
                  }}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    entryType === type
                      ? 'bg-decoricks-brown text-decoricks-light'
                      : 'text-decoricks-dark/60 hover:text-decoricks-dark bg-decoricks-dark/5'
                  }`}
                >
                  {type === 'income' ? 'Income' : type === 'expense' ? 'Expense' : 'Transfer'}
                </button>
              ))}
            </div>
          )}

          <Input
            label="Amount (PKR)"
            type="number"
            step="0.01"
            placeholder="0.00"
            value={formAmount}
            onChange={(e) => setFormAmount(e.target.value)}
            error={formErrors.amount}
            disabled={isSubmitting}
          />

          {entryType === 'income' && (
            <>
              <Select
                label="Category"
                options={getCategoryOptions()}
                value={formCategory}
                onChange={(e) => setFormCategory(e.target.value)}
                error={formErrors.category}
                disabled={isSubmitting}
              />
              <Select
                label="Source"
                options={getSourceOptions()}
                value={formSource}
                onChange={(e) => setFormSource(e.target.value)}
                error={formErrors.source}
                disabled={isSubmitting}
              />
            </>
          )}

          {entryType === 'expense' && (
            <Select
              label="Category"
              options={getCategoryOptions()}
              value={formCategory}
              onChange={(e) => setFormCategory(e.target.value)}
              error={formErrors.category}
              disabled={isSubmitting}
            />
          )}

          {entryType === 'transfer' && (
            <>
              <Select
                label="From Account"
                options={accountOptions}
                value={formFromAccount}
                onChange={(e) => setFormFromAccount(e.target.value)}
                error={formErrors.fromAccount}
                disabled={isSubmitting}
              />
              <Select
                label="To Account"
                options={accountOptions}
                value={formToAccount}
                onChange={(e) => setFormToAccount(e.target.value)}
                error={formErrors.toAccount}
                disabled={isSubmitting}
              />
            </>
          )}

          <Input
            label="Date"
            type="date"
            value={formDate}
            onChange={(e) => setFormDate(e.target.value)}
            error={formErrors.date}
            disabled={isSubmitting}
          />
          <Textarea
            label="Description (optional)"
            placeholder="Enter description..."
            value={formDescription}
            onChange={(e) => setFormDescription(e.target.value)}
            error={formErrors.description}
            disabled={isSubmitting}
            rows={3}
          />

          {formErrors.general && <p className="text-sm text-red-500">{formErrors.general}</p>}

          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={closeModal} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" loading={isSubmitting} disabled={isSubmitting}>
              {editingEntry ? 'Update' : 'Add'} {entryType === 'income' ? 'Income' : entryType === 'expense' ? 'Expense' : 'Transfer'}
            </Button>
          </div>
        </form>
      </Modal>
    </PageTransition>
  )
}
