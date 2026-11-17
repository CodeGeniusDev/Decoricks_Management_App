'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { PageTransition } from '@/components/PageTransition'
import { PageHeader, Metric, MetricGrid } from '@/components/layout/Page'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { Table } from '@/components/ui/Table'
import { ExportLink } from '@/components/ui/ExportLink'
import { useRealtimeSync } from '@/lib/sync/useRealtime'
import { usePolling } from '@/hooks/usePolling'
import { apiJson, apiJsonMeta } from '@/lib/api-client'
import { useAuth } from '@/components/auth/AuthProvider'
import { can } from '@/lib/permissions-client'
import { formatPaisa } from '@/lib/money'
import { formatKarachiDate } from '@/lib/date'
import { toKarachiInputDate } from '@/modules/finance/finance-ui'

interface PartnerInvestmentLine {
  partnerName: string
  partnerId?: string
  capitalIn: number
  withdrawalsOut: number
  netBalance: number
  capitalTransactionCount: number
  withdrawalTransactionCount: number
}

interface PartnerInvestmentSummary {
  partners: PartnerInvestmentLine[]
  totalCapitalIn: number
  totalWithdrawalsOut: number
  totalNetBalance: number
  range: { start: string; end: string }
  transactionCount: number
}

export default function PartnerInvestmentPage() {
  const { user } = useAuth()
  const canView = user ? can({ role: user.role }, 'finance', 'view') : false

  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [data, setData] = useState<PartnerInvestmentSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useRealtimeSync('finance', () => {
    void load({ background: true })
  })

  const load = useCallback(
    async (options?: { background?: boolean }) => {
      const background = options?.background === true
      if (!startDate || !endDate) {
        if (!background) setLoading(false)
        return
      }
      if (!background) setLoading(true)
      setError(null)
      try {
        const { data: result } = await apiJsonMeta<PartnerInvestmentSummary>(
          `/api/finance/partner-investment?startDate=${startDate}&endDate=${endDate}`
        )
        setData(result)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load partner investment data')
      } finally {
        if (!background) setLoading(false)
      }
    },
    [startDate, endDate]
  )

  usePolling(() => load({ background: true }), { error })

  useEffect(() => {
    void load()
  }, [load])

  const handleSearch = () => {
    void load()
  }

  const body = () => {
    if (loading) {
      return (
        <>
          <Skeleton variant="rect" className="h-24" />
          <Skeleton variant="rect" className="mt-4 h-64" />
        </>
      )
    }
    if (error) {
      return (
        <Card>
          <EmptyState
            title="Could not load data"
            description={error}
            action={{ label: 'Retry', onClick: () => void load() }}
          />
        </Card>
      )
    }
    if (!data) {
      return (
        <Card>
          <EmptyState
            title="Select a date range"
            description="Choose start and end dates to view partner investment summary."
          />
        </Card>
      )
    }

    const rangeLabel = `${formatKarachiDate(new Date(data.range.start), 'date')} – ${formatKarachiDate(
      new Date(data.range.end),
      'date'
    )} (Karachi)`

    const exportParams = new URLSearchParams({
      startDate,
      endDate,
    }).toString()

    return (
      <>
        <MetricGrid>
          <Metric
            label="Total capital invested"
            value={formatPaisa(data.totalCapitalIn)}
            hint={`In ${rangeLabel}`}
          />
          <Metric
            label="Total withdrawals"
            value={formatPaisa(data.totalWithdrawalsOut)}
            hint={`In ${rangeLabel}`}
          />
          <Metric
            label="Net balance"
            value={formatPaisa(data.totalNetBalance)}
            tone={data.totalNetBalance < 0 ? 'negative' : 'positive'}
            hint={`In ${rangeLabel}`}
          />
          <Metric
            label="Transactions"
            value={data.transactionCount.toString()}
            hint={`In ${rangeLabel}`}
          />
        </MetricGrid>

        <div className="mt-4">
          <Card className="p-4">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-decoricks-dark">
                Partner-wise Investment Summary
              </h2>
              <ExportLink href={`/api/finance/partner-investment/export?${exportParams}`}>
                Export CSV
              </ExportLink>
            </div>

            {data.partners.length === 0 ? (
              <EmptyState
                title="No partner transactions"
                description="No partner capital or withdrawal transactions found in this date range."
              />
            ) : (
              <Table
                columns={[
                  { key: 'partner', label: 'Partner' },
                  { key: 'capitalIn', label: 'Capital Invested' },
                  { key: 'withdrawalsOut', label: 'Withdrawals' },
                  { key: 'netBalance', label: 'Net Balance' },
                  { key: 'transactions', label: 'Transactions' },
                ]}
                data={data.partners.map((partner) => ({
                  partner: (
                    <span className="font-medium text-decoricks-dark">{partner.partnerName}</span>
                  ),
                  capitalIn: (
                    <span className="tabular-nums text-status-success">
                      {formatPaisa(partner.capitalIn)}
                    </span>
                  ),
                  withdrawalsOut: (
                    <span className="tabular-nums text-status-danger">
                      {formatPaisa(partner.withdrawalsOut)}
                    </span>
                  ),
                  netBalance: (
                    <span
                      className={`tabular-nums ${
                        partner.netBalance < 0 ? 'text-status-danger' : 'text-decoricks-dark'
                      }`}
                    >
                      {formatPaisa(partner.netBalance)}
                    </span>
                  ),
                  transactions: (
                    <span className="text-xs text-ink-muted">
                      {partner.capitalTransactionCount} capital · {partner.withdrawalTransactionCount} withdrawal
                    </span>
                  ),
                }))}
              />
            )}
          </Card>
        </div>
      </>
    )
  }

  return (
    <PageTransition>
      <PageHeader title="Partner Investment" />

      <Card className="mb-4 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="sm:w-44">
            <Input
              label="Start Date (Karachi)"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div className="sm:w-44">
            <Input
              label="End Date (Karachi)"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
          <Button onClick={handleSearch} disabled={!startDate || !endDate || loading}>
            Search
          </Button>
        </div>
        <p className="mt-2 text-xs text-ink-muted">
          Select a date range to view partner capital contributions and withdrawals.
          The net balance shows how much each partner has invested (capital) versus withdrawn.
        </p>
      </Card>

      {body()}
    </PageTransition>
  )
}
