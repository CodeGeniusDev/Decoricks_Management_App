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
import { formatPaisa, pkrToPaisa } from '@/lib/money'
import { getStartOfMonth, getEndOfMonth } from '@/lib/date'
import { apiFetch } from '@/lib/api-client'

interface BudgetActual {
  categoryId: string
  category: string
  budgetedAmount: number
  budgetedDisplay: string
  actualAmount: number
  actualDisplay: string
  variance: number
  varianceDisplay: string
  variancePercent: number
  status: 'under' | 'over' | 'on_track'
}

interface BudgetCategory {
  category: string
  budgeted: number // paisa
  actual: number // paisa, aggregated from real expenses
  remaining: number
  percentUsed: number
}

interface Budget {
  _id: string
  budgetNumber?: string
  name: string
  periodStart: string
  periodEnd: string
  status: 'draft' | 'active' | 'archived'
  categories: BudgetCategory[]
  totalBudgeted: number
  totalActual: number
  totalRemaining: number
  percentUsed: number
  approvedBy?: string
  approvedAt?: string
  createdAt: string
  updatedAt: string
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

export default function BudgetsPage() {
  const [budgets, setBudgets] = useState<Budget[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const isSubmittingRef = useRef(false)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingBudget, setEditingBudget] = useState<Budget | null>(null)
  const [toastMessage, setToastMessage] = useState<{
    type: 'success' | 'error' | 'info' | 'warning'
    message: string
  } | null>(null)

  // Form state
  const [formName, setFormName] = useState('')
  const [formPeriodStart, setFormPeriodStart] = useState('')
  const [formPeriodEnd, setFormPeriodEnd] = useState('')
  const [formCategoryBudgets, setFormCategoryBudgets] = useState<
    Array<{ category: string; amount: string }>
  >([{ category: 'meta_ads', amount: '0' }])
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})

  const fetchBudgets = useCallback(async () => {
    try {
      setLoading(true)
      setLoadError(null)
      const res = await apiFetch('/api/budgets')
      const body = await res.json()
      if (!res.ok || !body.success) {
        throw new Error(body?.error?.message || 'Failed to load budgets')
      }
      setBudgets(body.data)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load budgets')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchBudgets()
  }, [fetchBudgets])

  /** Variance for the active budget, derived from stored budgets and expenses. */
  const getBudgetActuals = (): BudgetActual[] => {
    const budget = budgets.find((b) => b.status === 'active')
    if (!budget) return []

    return budget.categories.map((c) => {
      const variance = c.budgeted - c.actual
      return {
        categoryId: c.category,
        category: c.category.replace(/_/g, ' '),
        budgetedAmount: c.budgeted,
        budgetedDisplay: formatPaisa(c.budgeted),
        actualAmount: c.actual,
        actualDisplay: formatPaisa(c.actual),
        variance,
        varianceDisplay: formatPaisa(variance),
        variancePercent: c.percentUsed,
        status: variance >= 0 ? 'under' : 'over',
      }
    })
  }

  const resetForm = () => {
    setFormName('')
    const monthStart = getStartOfMonth()
    const monthEnd = getEndOfMonth()
    setFormPeriodStart(monthStart.toISOString().split('T')[0])
    setFormPeriodEnd(monthEnd.toISOString().split('T')[0])
    setFormCategoryBudgets([{ category: 'meta_ads', amount: '0' }])
    setFormErrors({})
    setEditingBudget(null)
  }

  const openModal = () => {
    resetForm()
    setIsModalOpen(true)
  }

  const openEditModal = (budget: Budget) => {
    setEditingBudget(budget)
    setFormName(budget.name)
    setFormPeriodStart(budget.periodStart)
    setFormPeriodEnd(budget.periodEnd)
    setFormCategoryBudgets(
      budget.categories.map((c) => ({
        category: c.category,
        amount: formatPaisaInput(c.budgeted),
      }))
    )
    setFormErrors({})
    setIsModalOpen(true)
  }

  const formatPaisaInput = (paisa: number): string => {
    return (paisa / 100).toFixed(2)
  }

  const closeModal = () => {
    setIsModalOpen(false)
    resetForm()
  }

  const addCategoryRow = () => {
    setFormCategoryBudgets([...formCategoryBudgets, { category: 'miscellaneous', amount: '0' }])
  }

  const removeCategoryRow = (index: number) => {
    if (formCategoryBudgets.length > 1) {
      const newBudgets = [...formCategoryBudgets]
      newBudgets.splice(index, 1)
      setFormCategoryBudgets(newBudgets)
    }
  }

  const updateCategoryRow = (index: number, field: 'category' | 'amount', value: string) => {
    const newBudgets = [...formCategoryBudgets]
    newBudgets[index] = { ...newBudgets[index], [field]: value }
    setFormCategoryBudgets(newBudgets)
  }

  const calculateTotal = (): number => {
    return formCategoryBudgets.reduce((sum, item) => {
      const amt = parseFloat(item.amount) || 0
      return sum + pkrToPaisa(amt)
    }, 0)
  }

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {}
    if (!formName.trim()) errors.name = 'Budget name is required'
    if (!formPeriodStart) errors.periodStart = 'Start date is required'
    if (!formPeriodEnd) errors.periodEnd = 'End date is required'
    if (new Date(formPeriodStart) > new Date(formPeriodEnd)) {
      errors.periodEnd = 'End date must be after start date'
    }
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
        name: formName.trim(),
        periodStart: formPeriodStart,
        periodEnd: formPeriodEnd,
        status: editingBudget?.status ?? 'draft',
        categories: formCategoryBudgets
          .filter((c) => c.category)
          .map((c) => ({
            category: c.category,
            // The form collects PKR; budgets are stored in paisa.
            budgeted: pkrToPaisa(parseFloat(c.amount) || 0),
          })),
      }

      const res = await apiFetch(editingBudget ? `/api/budgets/${editingBudget._id}` : '/api/budgets', {
        method: editingBudget ? 'PUT' : 'POST',
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
        throw new Error(body?.error?.message || 'Could not save budget')
      }

      setToastMessage({
        type: 'success',
        message: editingBudget ? 'Budget updated successfully' : 'Budget created successfully',
      })
      closeModal()
      await fetchBudgets()
    } catch (err) {
      setFormErrors((prev) => ({
        ...prev,
        general: err instanceof Error ? err.message : 'Could not save budget',
      }))
    } finally {
      isSubmittingRef.current = false
      setIsSubmitting(false)
    }
  }

  const approveBudget = async (budgetId: string) => {
    const previous = budgets
    setBudgets((current) =>
      current.map((b) => (b._id === budgetId ? { ...b, status: 'active', approvedAt: new Date().toISOString() } : b))
    )

    try {
      const res = await apiFetch(`/api/budgets/${budgetId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      })
      const body = await res.json()
      if (!res.ok || !body.success) throw new Error(body?.error?.message || 'Could not approve budget')

      setToastMessage({ type: 'success', message: 'Budget approved' })
      await fetchBudgets()
    } catch (err) {
      setBudgets(previous)
      setToastMessage({
        type: 'error',
        message: err instanceof Error ? err.message : 'Could not approve budget',
      })
    }
  }

  const archiveBudget = async (budgetId: string) => {
    const previous = budgets
    setBudgets((current) =>
      current.map((b) => (b._id === budgetId ? { ...b, status: 'archived' } : b))
    )

    try {
      const res = await apiFetch(`/api/budgets/${budgetId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'archived' }),
      })
      const body = await res.json()
      if (!res.ok || !body.success) throw new Error(body?.error?.message || 'Could not archive budget')

      setToastMessage({ type: 'info', message: 'Budget archived' })
      await fetchBudgets()
    } catch (err) {
      setBudgets(previous)
      setToastMessage({
        type: 'error',
        message: err instanceof Error ? err.message : 'Could not archive budget',
      })
    }
  }

  const deleteBudget = async (budgetId: string) => {
    if (!confirm('Are you sure you want to delete this budget?')) return

    const previous = budgets
    setBudgets((current) => current.filter((b) => b._id !== budgetId))

    try {
      const res = await apiFetch(`/api/budgets/${budgetId}`, { method: 'DELETE' })
      const body = await res.json()
      if (!res.ok || !body.success) {
        setBudgets(previous)
        throw new Error(body?.error?.message || 'Could not delete budget')
      }

      if (body.data?.archived) {
        setToastMessage({ type: 'warning', message: body.data.message })
      } else {
        setToastMessage({ type: 'success', message: 'Budget deleted' })
      }
      await fetchBudgets()
    } catch (err) {
      setBudgets(previous)
      setToastMessage({
        type: 'error',
        message: err instanceof Error ? err.message : 'Could not delete budget',
      })
    }
  }

  const budgetColumns = [
    { key: 'name', label: 'Name' },
    { key: 'period', label: 'Period' },
    { key: 'totalBudgeted', label: 'Total Budgeted' },
    { key: 'status', label: 'Status' },
    { key: 'actions', label: 'Actions' },
  ]

  const budgetTableData = budgets.map((budget) => ({
    name: budget.name,
    period: `${new Date(budget.periodStart).toLocaleDateString('en-PK')} - ${new Date(budget.periodEnd).toLocaleDateString('en-PK')}`,
    totalBudgeted: formatPaisa(budget.totalBudgeted),
    status: (
      <Badge variant={budget.status === 'active' ? 'success' : budget.status === 'draft' ? 'warning' : 'default'}>
        {budget.status}
      </Badge>
    ),
    actions: (
      <div className="flex gap-1">
        <Button variant="ghost" size="sm" onClick={() => openEditModal(budget)}>
          Edit
        </Button>
        {budget.status === 'draft' && (
          <>
            <Button variant="ghost" size="sm" onClick={() => approveBudget(budget._id)}>
              Approve
            </Button>
            <Button variant="ghost" size="sm" onClick={() => deleteBudget(budget._id)}>
              Delete
            </Button>
          </>
        )}
        {budget.status === 'active' && (
          <Button variant="ghost" size="sm" onClick={() => archiveBudget(budget._id)}>
            Archive
          </Button>
        )}
      </div>
    ),
  }))

  if (loading) {
    return (
      <PageTransition>
        <h1 className="text-2xl font-bold text-decoricks-dark mb-6">Budgets</h1>
        <Skeleton variant="rect" className="h-96" />
      </PageTransition>
    )
  }

  return (
    <PageTransition>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-decoricks-dark">Budgets</h1>
        <Button variant="primary" size="sm" onClick={openModal}>
          <IconPlus size={16}  />
          New Budget
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

      {/* Budget List */}
      {loadError && (
        <Card variant="default" className="p-6 mb-6 border-red-200">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-decoricks-dark">Could not load budgets</h2>
              <p className="text-sm text-decoricks-dark/60">{loadError}</p>
            </div>
            <Button variant="outline" onClick={fetchBudgets} type="button">
              Try again
            </Button>
          </div>
        </Card>
      )}

      {!loadError && budgets.length === 0 ? (
        <EmptyState
          title="No budgets yet"
          description="Create a budget to track expenses against planned amounts. This list only shows budgets you have created."
          action={{ label: 'New Budget', onClick: openModal }}
        />
      ) : (
        !loadError && (
          <Card className="mb-6">
            <div className="p-4">
              <Table columns={budgetColumns} data={budgetTableData} />
            </div>
          </Card>
        )
      )}

      {/* Budget vs Actual for active budget */}
      {budgets.some((b) => b.status === 'active') && (
        <Card className="mb-6">
          <div className="p-6">
            <h2 className="text-lg font-semibold text-decoricks-dark mb-4">Budget vs Actual</h2>
            <Table
              columns={[
                { key: 'category', label: 'Category' },
                { key: 'budgeted', label: 'Budgeted' },
                { key: 'actual', label: 'Actual' },
                { key: 'variance', label: 'Variance' },
                { key: 'status', label: 'Status' },
              ]}
              data={getBudgetActuals().map((item) => ({
                category: item.category,
                budgeted: item.budgetedDisplay,
                actual: item.actualDisplay,
                variance: (
                  <span
                    className={`font-medium ${item.variance >= 0 ? 'text-green-600' : 'text-red-500'}`}
                  >
                    {item.varianceDisplay}
                  </span>
                ),
                status: (
                  <Badge variant={item.variance >= 0 ? 'success' : 'error'}>
                    {item.variance >= 0 ? 'Under' : 'Over'}
                  </Badge>
                ),
              }))}
            />
          </div>
        </Card>
      )}

      {/* New/Edit Budget Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={closeModal}
        title={editingBudget ? 'Edit Budget' : 'New Budget'}
        size="xl"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Budget Name"
            placeholder="e.g. October 2024 Budget"
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            error={formErrors.name}
          />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Period Start"
              type="date"
              value={formPeriodStart}
              onChange={(e) => setFormPeriodStart(e.target.value)}
              error={formErrors.periodStart}
            />
            <Input
              label="Period End"
              type="date"
              value={formPeriodEnd}
              onChange={(e) => setFormPeriodEnd(e.target.value)}
              error={formErrors.periodEnd}
            />
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-decoricks-dark">Category Budgets</h3>
            {formCategoryBudgets.map((row, index) => (
              <div key={index} className="grid grid-cols-1 md:grid-cols-3 gap-2 items-end">
                <Select
                  label="Category"
                  options={EXPENSE_CATEGORIES.map((c) => ({ value: c, label: c }))}
                  value={row.category}
                  onChange={(e) => updateCategoryRow(index, 'category', e.target.value)}
                />
                <Input
                  label="Amount (PKR)"
                  type="number"
                  step="0.01"
                  value={row.amount}
                  onChange={(e) => updateCategoryRow(index, 'amount', e.target.value)}
                  placeholder="0.00"
                />
                <div className="pb-1">
                  {formCategoryBudgets.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeCategoryRow(index)}
                      className="text-red-500 hover:text-red-700 text-sm"
                      aria-label="Remove category"
                    >
                      × Remove
                    </button>
                  )}
                </div>
              </div>
            ))}
            <Button variant="ghost" size="sm" onClick={addCategoryRow} type="button"
            >
              + Add Category
            </Button>
          </div>

          <div className="flex justify-end">
            <div className="text-right">
              <span className="text-sm text-decoricks-dark/60">Total Budgeted: </span>
              <span className="font-bold">{formatPaisa(calculateTotal())}</span>
            </div>
          </div>

          {formErrors.general && <p className="text-sm text-red-500">{formErrors.general}</p>}

          <div className="flex justify-end gap-2 pt-4 border-t">
            <Button variant="outline" onClick={closeModal} type="button"
            >
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : editingBudget ? 'Update Budget' : 'Create Budget'}
            </Button>
          </div>
        </form>
      </Modal>
    </PageTransition>
  )
}
