'use client'

import { useState } from 'react'
import { UsersTab } from '@/components/settings/UsersTab'
import { PermissionsTab } from '@/components/settings/PermissionsTab'
import { AuditLogTab } from '@/components/settings/AuditLogTab'
import { PageTransition } from '@/components/PageTransition'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Tabs } from '@/components/ui/Tabs'
import { Badge } from '@/components/ui/Badge'
import { Table } from '@/components/ui/Table'
import { Toast } from '@/components/ui/Toast'

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

export default function SettingsPage() {
  const [toastMessage, setToastMessage] = useState<{
    type: 'success' | 'error' | 'info' | 'warning'
    message: string
  } | null>(null)

  // Business settings state
  const [profitShare, setProfitShare] = useState({
    abdullah: 20,
    hasnat: 20,
    ali: 20,
    afnan: 20,
    charity: 20,
  })
  const [lowStockThreshold, setLowStockThreshold] = useState(5)
  const [withdrawalLocked, setWithdrawalLocked] = useState(true)
  const [budgetApprovalThreshold, setBudgetApprovalThreshold] = useState('')

  // Expense categories state
  const [expenseCategories, setExpenseCategories] = useState<string[]>([
    ...EXPENSE_CATEGORIES,
  ])
  const [newCategory, setNewCategory] = useState('')

  const addCategory = () => {
    if (newCategory.trim() && !expenseCategories.includes(newCategory.trim())) {
      setExpenseCategories([...expenseCategories, newCategory.trim()])
      setNewCategory('')
      setToastMessage({ type: 'success', message: 'Category added' })
    }
  }

  const removeCategory = (cat: string) => {
    setExpenseCategories(expenseCategories.filter((c) => c !== cat))
    setToastMessage({ type: 'info', message: 'Category removed' })
  }

  const saveBusinessSettings = () => {
    setToastMessage({ type: 'success', message: 'Business settings saved' })
  }

  const totalProfitShare =
    profitShare.abdullah +
    profitShare.hasnat +
    profitShare.ali +
    profitShare.afnan +
    profitShare.charity

  return (
    <PageTransition>
      <h1 className="text-2xl font-bold text-decoricks-dark mb-6">Settings</h1>

      {toastMessage && (
        <div className="fixed top-20 right-4 z-50">
          <Toast
            message={toastMessage.message}
            type={toastMessage.type}
            onClose={() => setToastMessage(null)}
          />
        </div>
      )}

      <Tabs
        tabs={[
          { id: 'business', label: 'Business Settings' },
          { id: 'categories', label: 'Expense Categories' },
          { id: 'users', label: 'Users & Roles' },
          { id: 'permissions', label: 'Permissions' },
          { id: 'audit', label: 'Audit Log' },
          { id: 'export', label: 'Data Export/Backup' },
        ]}
        defaultTab="business"
      >
        {(tab) => {
          switch (tab) {
            case 'business':
              return (
                <Card className="p-6">
                  <h2 className="text-lg font-semibold text-decoricks-dark mb-4">
                    Profit Sharing Configuration
                  </h2>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-6">
                    <Input
                      label="Abdullah (%)"
                      type="number"
                      value={profitShare.abdullah.toString()}
                      onChange={(e) =>
                        setProfitShare({ ...profitShare, abdullah: parseInt(e.target.value) || 0 })
                      }
                      min={0}
                      max={100}
                    />
                    <Input
                      label="Hasnat (%)"
                      type="number"
                      value={profitShare.hasnat.toString()}
                      onChange={(e) =>
                        setProfitShare({ ...profitShare, hasnat: parseInt(e.target.value) || 0 })
                      }
                      min={0}
                      max={100}
                    />
                    <Input
                      label="Ali (%)"
                      type="number"
                      value={profitShare.ali.toString()}
                      onChange={(e) =>
                        setProfitShare({ ...profitShare, ali: parseInt(e.target.value) || 0 })
                      }
                      min={0}
                      max={100}
                    />
                    <Input
                      label="Afnan (%)"
                      type="number"
                      value={profitShare.afnan.toString()}
                      onChange={(e) =>
                        setProfitShare({ ...profitShare, afnan: parseInt(e.target.value) || 0 })
                      }
                      min={0}
                      max={100}
                    />
                    <Input
                      label="Charity (%)"
                      type="number"
                      value={profitShare.charity.toString()}
                      onChange={(e) =>
                        setProfitShare({ ...profitShare, charity: parseInt(e.target.value) || 0 })
                      }
                      min={0}
                      max={100}
                    />
                    <div className="flex items-end">
                      <Badge variant={totalProfitShare === 100 ? 'success' : 'error'}>
                        Total: {totalProfitShare}%
                      </Badge>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                    <Input
                      label="Low Stock Threshold"
                      type="number"
                      value={lowStockThreshold.toString()}
                      onChange={(e) => setLowStockThreshold(parseInt(e.target.value) || 0)}
                      min={0}
                    />
                    <Input
                      label="Budget Approval Threshold (PKR)"
                      type="number"
                      value={budgetApprovalThreshold}
                      onChange={(e) => setBudgetApprovalThreshold(e.target.value)}
                      placeholder="Leave empty to disable"
                    />
                  </div>

                  <div className="flex items-center gap-4 mb-6">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={withdrawalLocked}
                        onChange={(e) => setWithdrawalLocked(e.target.checked)}
                        className="w-4 h-4"
                      />
                      <span className="text-sm text-decoricks-dark">Lock partner withdrawals</span>
                    </label>
                  </div>

                  <div className="flex justify-end">
                    <Button variant="primary" onClick={saveBusinessSettings}>
                      Save Business Settings
                    </Button>
                  </div>
                </Card>
              )

            case 'categories':
              return (
                <Card className="p-6">
                  <h2 className="text-lg font-semibold text-decoricks-dark mb-4">
                    Expense Categories
                  </h2>
                  <div className="flex gap-2 mb-4">
                    <Input
                      aria-label="New expense category"
                      placeholder="New category..."
                      value={newCategory}
                      onChange={(e) => setNewCategory(e.target.value)}
                      className="max-w-xs"
                    />
                    <Button variant="outline" onClick={addCategory} disabled={!newCategory.trim()}>
                      Add
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {expenseCategories.map((cat) => (
                      <Badge key={cat} variant="default" className="px-3 py-1">
                        {cat}
                        <button
                          type="button"
                          onClick={() => removeCategory(cat)}
                          className="ml-2 hover:text-red-500"
                          aria-label={`Remove ${cat}`}
                        >
                          ×
                        </button>
                      </Badge>
                    ))}
                  </div>
                </Card>
              )

            case 'users':
              return <UsersTab />

            case 'permissions':
              return <PermissionsTab />

            case 'audit':
              return <AuditLogTab />

            case 'export':
              return (
                <Card className="p-6">
                  <h2 className="text-lg font-semibold text-decoricks-dark mb-4">
                    Data Export / Backup
                  </h2>
                  <div className="space-y-4">
                    <p className="text-sm text-decoricks-dark/60">
                      Export all application data as a JSON file. This includes all collections
                      from your database.
                    </p>
                    <Button variant="secondary" onClick={() => setToastMessage({ type: 'info', message: 'Export started...' })}>
                      Export Now
                    </Button>
                  </div>
                </Card>
              )

            default:
              return null
          }
        }}
      </Tabs>
    </PageTransition>
  )
}
