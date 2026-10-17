import DashboardView from '@/components/dashboard/DashboardView'

/**
 * The central dashboard route. The whole board lives in `DashboardView` (a client
 * component) so this page stays a thin server boundary. This replaces the legacy
 * per-widget `dashboard/summary` + `finance/summary` composition (METRICS.md §I).
 */
export default function DashboardPage() {
  return <DashboardView />
}
