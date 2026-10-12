'use client'

import Link from 'next/link'
import { UsersTab } from '@/components/settings/UsersTab'
import { PermissionsTab } from '@/components/settings/PermissionsTab'
import { AuditLogTab } from '@/components/settings/AuditLogTab'
import { BusinessSettingsTab } from '@/components/settings/BusinessSettingsTab'
import { PageTransition } from '@/components/PageTransition'
import { Card } from '@/components/ui/Card'
import { Tabs } from '@/components/ui/Tabs'
import { ExportLink } from '@/components/ui/ExportLink'

export default function SettingsPage() {
  return (
    <PageTransition>
      <h1 className="text-2xl font-bold text-decoricks-dark mb-6">Settings</h1>

      <Tabs
        tabs={[
          { id: 'business', label: 'Business Settings' },
          { id: 'users', label: 'Users & Roles' },
          { id: 'permissions', label: 'Permissions' },
          { id: 'audit', label: 'Audit Log' },
          { id: 'export', label: 'Data Export' },
        ]}
        defaultTab="business"
      >
        {(tab) => {
          switch (tab) {
            case 'business':
              return <BusinessSettingsTab />

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
                    Data Export
                  </h2>
                  <p className="mb-4 text-sm text-decoricks-dark/60">
                    Download the current books as CSV files. Each export honors the
                    same server-side permissions as the screens it comes from — the
                    file contains exactly what your role is allowed to see.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <ExportLink href="/api/finance/export">Transactions CSV</ExportLink>
                    <ExportLink href="/api/products/export">Products CSV</ExportLink>
                    <ExportLink href="/api/stock/export">Stock CSV</ExportLink>
                    <ExportLink href="/api/orders/export">Orders CSV</ExportLink>
                  </div>
                  <p className="mt-4 text-xs text-ink-muted">
                    Expense categories are managed under{' '}
                    <Link href="/finance/categories" className="text-decoricks-brown hover:underline">
                      Finance → Categories
                    </Link>
                    .
                  </p>
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
