'use client'

import { useConnectionState } from '@/lib/sync/useRealtime'
import { IconOffline } from '@/components/ui/icons'

/**
 * Realtime health, derived from the shared connection store — this component
 * opens nothing and holds no timers; it only reads. The wording is honest about
 * the delivery mode: an open SSE stream reads "Live", while the automatic
 * polling fallback reads "Live · sync" rather than pretending to be a stream.
 */
export function ConnectionStatus() {
  const { state, mode } = useConnectionState()

  const label =
    state === 'live'
      ? mode === 'sse'
        ? 'Live'
        : 'Live · syncing'
      : state === 'connecting'
        ? 'Connecting…'
        : state === 'reconnecting'
          ? 'Reconnecting…'
          : 'Offline'

  const dot =
    state === 'live'
      ? 'bg-status-success'
      : state === 'offline'
        ? 'bg-status-danger'
        : 'bg-status-warning'

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-line-subtle bg-surface-sunken px-2.5 py-1 text-xs text-ink-secondary"
      role="status"
      aria-live="polite"
    >
      <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden />
      {label}
    </span>
  )
}

/**
 * Full-width banner shown only when there is genuinely no connectivity. Sending
 * is disabled elsewhere by reading the same state; this makes the *reason*
 * explicit and reassures the user their draft text is preserved.
 */
export function OfflineBanner({ offline }: { offline: boolean }) {
  if (!offline) return null
  return (
    <div
      className="flex items-center justify-center gap-2 bg-status-warning-bg px-4 py-2 text-sm text-ink-secondary"
      role="alert"
    >
      <IconOffline className="h-4 w-4" aria-hidden />
      You are offline. Your draft is kept — sending resumes when you reconnect.
    </div>
  )
}
