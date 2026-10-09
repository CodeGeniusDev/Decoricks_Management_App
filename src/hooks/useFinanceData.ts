'use client'

import { useState, useEffect, useCallback } from 'react'

export interface FinancialEntry {
  _id: string
  incomeNumber?: string
  expenseNumber?: string
  amount: number
  amountDisplay: string
  category: string
  source: string
  description?: string
  date: string
  createdAt: string
  type: 'income' | 'expense' | 'transfer'
}

export interface FinancialData {
  income: { items: FinancialEntry[]; pagination: unknown }
  expenses: { items: FinancialEntry[]; pagination: unknown }
  transfers: { items: FinancialEntry[]; pagination: unknown }
}

export interface UseFinanceDataResult {
  data: FinancialData | null
  income: FinancialEntry[]
  expenses: FinancialEntry[]
  transfers: FinancialEntry[]
  summary: {
    mtdIncome: number
    mtdIncomeDisplay: string
    mtdExpenses: number
    mtdExpensesDisplay: string
    netCashFlow: number
    netCashFlowDisplay: string
    recentIncome: unknown[]
    recentExpenses: unknown[]
  } | null
  loading: boolean
  error: string | null
  summaryError: string | null
  refetch: () => Promise<void>
  fetchIncome: () => Promise<FinancialEntry[]>
  fetchExpenses: () => Promise<FinancialEntry[]>
}

export function useFinanceData(): UseFinanceDataResult {
  const [data, setData] = useState<FinancialData | null>(null)
  const [summary, setSummary] = useState<UseFinanceDataResult['summary']>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)

  const fetchAll = useCallback(async () => {
    try {
      setError(null)
      const [entriesRes, summaryRes] = await Promise.all([
        fetch('/api/finance?type=all&limit=100'),
        fetch('/api/finance/summary'),
      ])

      if (!entriesRes.ok) {
        throw new Error(`API error: ${entriesRes.status}`)
      }

      const entriesData = await entriesRes.json()
      if (entriesData.success === false) {
        throw new Error(entriesData.error?.message || 'Failed to load finance entries')
      }

      const financeData: FinancialData = {
        income: {
          items: entriesData.data?.income?.items || [],
          pagination: entriesData.data?.income?.pagination,
        },
        expenses: {
          items: entriesData.data?.expenses?.items || [],
          pagination: entriesData.data?.expenses?.pagination,
        },
        transfers: {
          items: entriesData.data?.transfers?.items || [],
          pagination: entriesData.data?.transfers?.pagination,
        },
      }

      setData(financeData)

      // The summary is independent of the table. If only the summary request
      // fails, keep the table and drop the summary rather than substituting a
      // fabricated all-zero summary that would read as genuine data.
      if (!summaryRes.ok) {
        setSummary(null)
        setSummaryError(`Summary API error: ${summaryRes.status}`)
        return
      }

      const summaryData = await summaryRes.json()
      if (summaryData.success === false) {
        setSummary(null)
        setSummaryError(summaryData.error?.message || 'Failed to load finance summary')
        return
      }

      setSummary(summaryData.data ?? null)
      setSummaryError(null)
    } catch (err) {
      // Keep whatever is already on screen — a failed background refresh must
      // not wipe the user's table.
      setError(err instanceof Error ? err.message : 'Failed to fetch finance data')
    } finally {
      setLoading(false)
    }
  }, [])

  /**
   * Refresh after a mutation without blanking the table. Only the very first
   * load flips `loading`, so unrelated UI state (open modal, active tab, typed
   * input) is never reset by a refetch.
   */
  const refetch = useCallback(async () => {
    await fetchAll()
  }, [fetchAll])

  const fetchIncome = useCallback(async () => {
    try {
      const res = await fetch('/api/finance?type=income&limit=100')
      if (!res.ok) throw new Error(`API error: ${res.status}`)
      const json = await res.json()
      return json.data?.income?.items || []
    } catch (err) {
      throw err
    }
  }, [])

  const fetchExpenses = useCallback(async () => {
    try {
      const res = await fetch('/api/finance?type=expense&limit=100')
      if (!res.ok) throw new Error(`API error: ${res.status}`)
      const json = await res.json()
      return json.data?.expenses?.items || []
    } catch (err) {
      throw err
    }
  }, [])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  return {
    data,
    income: data?.income?.items || [],
    expenses: data?.expenses?.items || [],
    transfers: data?.transfers?.items || [],
    summary,
    loading,
    error,
    summaryError,
    refetch,
    fetchIncome,
    fetchExpenses,
  }
}
