'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { PageTransition } from '@/components/PageTransition';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Table } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Toast } from '@/components/ui/Toast';
import { formatPaisa } from '@/lib/money';
import { formatKarachiDate } from '@/lib/date';

/** Serialized ledger entry as returned by the Phase 3 finance API. */
interface LedgerEntryView {
  _id: string;
  type: string;
  amount: number;
  amountDisplay: string;
  date: string;
  accountName?: string;
  category?: string;
  categoryLabel?: string;
  partnerName?: string;
  paymentMethod?: string;
  note?: string;
  isReversal: boolean;
  status: 'posted' | 'reversed';
}

interface DashboardSummary {
  mtdIncome: number;
  mtdIncomeDisplay: string;
  mtdExpenses: number;
  mtdExpensesDisplay: string;
  netCashFlow: number;
  netCashFlowDisplay: string;
  recentIncome: LedgerEntryView[];
  recentExpenses: LedgerEntryView[];
}

interface DashboardAggregates {
  generatedAt: string;
  counts: { openTasks: number; orders: number };
  revenueTrend7d: Array<{ date: string; income: number; expenses: number }>;
  ordersTrend30d: Array<{ date: string; revenue: number; orders: number }>;
  stockByLocation: Array<{
    location: string;
    label: string;
    units: number;
    valuePaisa: number;
    valueDisplay: string;
  }>;
  stockValueDisplay: string;
  lifetimeOrderRevenueDisplay: string;
}

const STOCK_COLUMNS = [
  { key: 'location', label: 'Location' },
  { key: 'value', label: 'Value' },
  { key: 'items', label: 'Items' },
];

export default function DashboardPage() {
  const router = useRouter();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aggregates, setAggregates] = useState<DashboardAggregates | null>(null);
  const [toastMessage, setToastMessage] = useState<{
    type: 'success' | 'error' | 'info' | 'warning';
    message: string;
  } | null>(null);

  const fetchSummary = useCallback(async (opts: { background?: boolean } = {}) => {
    // The server treats this header as "not user activity": the 60s auto-refresh
    // must not keep an idle session alive, while the first load (navigation) can.
    const headers = opts.background ? { 'x-session-background': '1' } : undefined;
    try {
      setError(null);
      const res = await fetch('/api/finance/summary', { headers });
      if (!res.ok) throw new Error('Failed to fetch dashboard data');
      const result = await res.json();
      if (!result.success) throw new Error(result.error?.message || 'API error');
      setSummary(result.data);

      // Dashboard aggregates (stock, order trends) come from the same database.
      try {
        const aggRes = await fetch('/api/dashboard/summary', { headers });
        const aggBody = await aggRes.json();
        if (aggRes.ok && aggBody.success) setAggregates(aggBody.data);
      } catch {
        // The finance cards still render if the aggregate read fails.
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSummary();
    // Poll every 60 seconds for fresh data (without extending the session)
    const interval = setInterval(() => fetchSummary({ background: true }), 60000);
    return () => clearInterval(interval);
  }, [fetchSummary]);

  const quickActions = [
    { label: 'Add Order', href: '/sales', color: 'bg-decoricks-brown' },
    { label: 'Add Expense', href: '/finance', color: 'bg-red-500' },
    { label: 'Add Task', href: '/tasks', color: 'bg-blue-500' },
    { label: 'Add Product', href: '/inventory', color: 'bg-green-500' },
  ];

  /** Real 7-day income/expense series from the finance collections. */
  const revenueData = (aggregates?.revenueTrend7d ?? []).flatMap((row) => {
    const label = new Date(row.date).toLocaleDateString('en-PK', {
      month: 'short',
      day: 'numeric',
    });
    const entries: { id: string; date: string; type: string; amount: string; color: string }[] = [];
    if (row.income > 0) {
      entries.push({
        id: `${row.date}:income`,
        date: label,
        type: 'Revenue',
        amount: formatPaisa(row.income),
        color: 'text-green-600',
      });
    }
    if (row.expenses > 0) {
      entries.push({
        id: `${row.date}:expense`,
        date: label,
        type: 'Expenses',
        amount: formatPaisa(row.expenses),
        color: 'text-red-500',
      });
    }
    return entries;
  });

  const stockData = aggregates?.stockByLocation ?? [];

  /** Real monthly order revenue for the last 30 days. */
  const profitData = (aggregates?.ordersTrend30d ?? []).map((row) => ({
    date: new Date(row.date).toLocaleDateString('en-PK', { month: 'short', day: 'numeric' }),
    amount: formatPaisa(row.revenue),
    color: 'text-green-600',
  }));

  if (loading) {
    return (
      <PageTransition>
        <h1 className="text-2xl font-bold text-decoricks-dark mb-6">Dashboard</h1>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} variant="rect" className="h-24" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          <Skeleton variant="rect" className="h-64" />
          <Skeleton variant="rect" className="h-64" />
        </div>
        <Skeleton variant="rect" className="h-48" />
      </PageTransition>
    );
  }

  return (
    <PageTransition>
      <h1 className="text-2xl font-bold text-decoricks-dark mb-6">Dashboard</h1>

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
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-6">
          <Card className="p-6 text-center">
            <p className="text-sm text-decoricks-dark/60 mb-2">MTD Revenue</p>
            <p className="text-2xl font-bold text-green-600">{summary.mtdIncomeDisplay}</p>
          </Card>
          <Card className="p-6 text-center">
            <p className="text-sm text-decoricks-dark/60 mb-2">MTD Expenses</p>
            <p className="text-2xl font-bold text-red-500">{summary.mtdExpensesDisplay}</p>
          </Card>
          <Card className="p-6 text-center">
            {/* This is income minus expenses for the month, not accounting
                profit — label it for what it actually measures. */}
            <p className="text-sm text-decoricks-dark/60 mb-2">MTD Net Cash Flow</p>
            <p
              className={`text-2xl font-bold ${summary.netCashFlow >= 0 ? 'text-green-600' : 'text-red-500'}`}
            >
              {summary.netCashFlowDisplay}
            </p>
          </Card>
          <Card className="p-6 text-center">
            <p className="text-sm text-decoricks-dark/60 mb-2">Open Tasks</p>
            <p className="text-2xl font-bold text-decoricks-brown">
              {aggregates?.counts.openTasks ?? 0}
            </p>
          </Card>
        </div>
      )}

      {/* Charts Section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Revenue vs Expenses Chart */}
        <Card className="p-6">
          <h3 className="text-lg font-semibold text-decoricks-dark mb-4">
            Revenue vs Expenses (7-day)
          </h3>
          {revenueData.length > 0 ? (
            <div className="space-y-3">
              {revenueData.map((row) => (
                <div key={row.id} className="flex items-center justify-between">
                  <span className="text-sm text-decoricks-dark/70">{row.date}</span>
                  <span className={`text-sm font-medium ${row.color}`}>
                    {row.type}: {row.amount}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No revenue data yet"
              description="Record income and expenses to see trends"
            />
          )}
        </Card>

        {/* Stock Levels Chart */}
        <Card className="p-6">
          <h3 className="text-lg font-semibold text-decoricks-dark mb-4">
            Stock Levels by Location
          </h3>
          {stockData.length === 0 ? (
            <EmptyState
              title="No stock yet"
              description="Add products and record stock to see levels by location."
            />
          ) : (
            <Table
              columns={STOCK_COLUMNS}
              data={stockData.map((row) => ({
                location: row.label,
                value: <span className="font-medium text-decoricks-dark">{row.valueDisplay}</span>,
                items: <Badge variant="default">{row.units} units</Badge>,
              }))}
            />
          )}
        </Card>
      </div>

      {/* Quick Actions + Recent Orders */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <Card className="p-6">
          <h3 className="text-lg font-semibold text-decoricks-dark mb-4">Quick Actions</h3>
          <div className="grid grid-cols-2 gap-3">
            {quickActions.map((action) => (
              <Button
                key={action.label}
                href={action.href}
                variant="ghost"
                className="w-full justify-center text-center"
                size="md"
              >
                {action.label}
              </Button>
            ))}
          </div>
        </Card>

        <Card className="p-6 lg:col-span-2">
          <h3 className="text-lg font-semibold text-decoricks-dark mb-4">Recent Income</h3>
          {summary?.recentIncome && summary.recentIncome.length > 0 ? (
            <Table
              columns={[
                { key: 'number', label: 'Ref' },
                { key: 'amount', label: 'Amount' },
                { key: 'category', label: 'Category' },
                { key: 'account', label: 'Account' },
                { key: 'date', label: 'Date' },
              ]}
              data={summary.recentIncome.map((item) => ({
                number: `#${item._id.slice(-6)}`,
                amount: item.amountDisplay,
                category: item.categoryLabel ?? item.category ?? '—',
                account: item.accountName ?? '—',
                date: formatKarachiDate(new Date(item.date), 'date'),
              }))}
            />
          ) : (
            <EmptyState
              title="No income recorded"
              description="Record income from the Finance module, or create an order in Sales"
              action={{
                label: 'Go to Sales',
                onClick: () => {
                  router.push('/sales');
                },
              }}
            />
          )}
        </Card>
      </div>

      {/* Recent Expenses + Profit Trend */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <Card className="p-6">
          <h3 className="text-lg font-semibold text-decoricks-dark mb-4">Recent Expenses</h3>
          {summary?.recentExpenses && summary.recentExpenses.length > 0 ? (
            <Table
              columns={[
                { key: 'number', label: 'Ref' },
                { key: 'amount', label: 'Amount' },
                { key: 'category', label: 'Category' },
                { key: 'account', label: 'Account' },
                { key: 'date', label: 'Date' },
              ]}
              data={summary.recentExpenses.map((item) => ({
                number: `#${item._id.slice(-6)}`,
                amount: <span className="text-red-500 font-medium">{item.amountDisplay}</span>,
                category: item.categoryLabel ?? item.category ?? '—',
                account: item.accountName ?? '—',
                date: formatKarachiDate(new Date(item.date), 'date'),
              }))}
            />
          ) : (
            <EmptyState
              title="No expenses recorded"
              description="Start tracking expenses from the Finance module"
            />
          )}
        </Card>

        <Card className="p-6">
          <h3 className="text-lg font-semibold text-decoricks-dark mb-4">Order Revenue (30-day)</h3>
          {profitData.length === 0 ? (
            <EmptyState
              title="No orders yet"
              description="Order revenue appears here once orders are created."
            />
          ) : (
            <div className="space-y-3">
              {profitData.map((row) => (
                <div key={row.date} className="flex items-center justify-between">
                  <span className="text-sm text-decoricks-dark/70">{row.date}</span>
                  <span className={`text-sm font-medium ${row.color}`}>{row.amount}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </PageTransition>
  );
}
