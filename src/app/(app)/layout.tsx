import { AppShell } from '@/components/layout/AppShell'
import { RequireAuth } from '@/components/auth/RequireAuth'
import { OfflineProvider } from '@/components/offline/OfflineProvider'

/**
 * Application chrome for every signed-in screen.
 *
 * Route groups are invisible in the URL, so this wraps `/`, `/finance`,
 * `/settings` and the rest without changing a single path.
 *
 * `OfflineProvider` sits inside `RequireAuth` so queue triggers and the
 * service-worker registration only ever run for a live session (Phase 9 §6).
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <RequireAuth>
        <OfflineProvider>{children}</OfflineProvider>
      </RequireAuth>
    </AppShell>
  )
}