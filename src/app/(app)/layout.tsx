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
 *
 * `AppShell` uses a shared `ShellLayoutProvider` so the collapsed/expanded
 * sidebar state survives across route transitions. The shell is mounted once
 * and never unmounted (the auth screens are in a separate route group), so
 * there is no flash of desktop chrome on a phone before hydration, and no
 * recreating the provider between pages — which was the source of the repeated
 * Fast Refresh full reloads: each navigation recreated the client tree and
 * every consumer of the unstable context re-rendered, the bundle recompiled,
 * and the HMR watcher spun in a tight loop.
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
