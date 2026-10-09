import { AppShell } from '@/components/layout/AppShell'
import { RequireAuth } from '@/components/auth/RequireAuth'

/**
 * Application chrome for every signed-in screen.
 *
 * Route groups are invisible in the URL, so this wraps `/`, `/finance`,
 * `/settings` and the rest without changing a single path.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <RequireAuth>{children}</RequireAuth>
    </AppShell>
  )
}