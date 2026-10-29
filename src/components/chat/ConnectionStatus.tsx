'use client'

import { useConnectionView } from '@/lib/sync/useRealtime'
import { IconOffline } from '@/components/ui/icons'

const TONE_DOT = {
  success: 'bg-status-success',
  warning: 'bg-status-warning',
  danger: 'bg-status-danger',
} as const

/**
 * Realtime health, derived from the shared connection store — this component
 * opens nothing and holds no timers; it only reads. The wording comes from
 * `lib/sync/connection-view`, the same function the dashboard chip and the
 * header now use, so there is exactly one meaning for each label app-wide: an
 * open stream reads "Live", the automatic polling fallback reads "Updating every
 * few seconds" rather than pretending to be a stream, and "Offline" is reserved
 * for what the browser itself reports. This chip used to hold its own copy of
 * that mapping, which is how two parts of the app ended up saying different
 * things about one connection.
 */
export function ConnectionStatus() {
  const { label, tone } = useConnectionView()

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-line-subtle bg-surface-sunken px-2.5 py-1 text-xs text-ink-secondary"
      role="status"
      aria-live="polite"
    >
      <span className={`h-2 w-2 rounded-full ${TONE_DOT[tone]}`} aria-hidden />
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
