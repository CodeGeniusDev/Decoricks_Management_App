'use client'

import { useState } from 'react'
import { UsersTab } from '@/components/settings/UsersTab'
import { PermissionsTab } from '@/components/settings/PermissionsTab'
import { AuditLogTab } from '@/components/settings/AuditLogTab'
import { BusinessSettingsTab } from '@/components/settings/BusinessSettingsTab'
import { PageTransition } from '@/components/PageTransition'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Tabs } from '@/components/ui/Tabs'
import { Badge } from '@/components/ui/Badge'
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
              return <BusinessSettingsTab />

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
