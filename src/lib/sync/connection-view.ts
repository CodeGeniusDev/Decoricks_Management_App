import type { ConnectionMode, ConnectionState } from './connection'

/**
 * The one place allowed to turn realtime health into words.
 *
 * WHY THIS EXISTS. Two components used to state connectivity independently and
 * disagree in production: the header pill read `navigator.onLine` and said
 * "Online" in green while the dashboard chip read the sync store and said
 * "Offline" in red, on the same phone, on the same second. Both were honest
 * about what they measured — they measured different things — but a user reads
 * two words about the same connection and one of them is a lie.
 *
 * The rule this file enforces is the brief's: **"Offline" is a browser fact,
 * not a transport fact.** `online === false` is the only input that can produce
 * it, so no store state, no default and no `stop()` on the way through a
 * client-side navigation can put red Offline on screen while the browser still
 * has a connection. Everything else describes the *delivery*, which is what the
 * transport actually knows:
 *
 *   live + sse       "Live"                       a stream is open and landing
 *   live + polling   "Updating every few seconds"  the fallback is carrying
 *                                                  updates, merely not instantly
 *   connecting       "Connecting…"                first attempt, nothing landed
 *   reconnecting     "Reconnecting…"              a stream dropped, retrying
 *   waking           "Server is waking up…"       the host is booting; the
 *                                                  reader supplies this because
 *                                                  only the data layer knows
 *
 * `online` is a parameter rather than a `navigator` read so this stays testable
 * in a node process with no DOM, and so the caller cannot accidentally pass a
 * stale copy: pass the live value.
 */

export const LIVE_LABEL = 'Live'
export const POLLING_LABEL = 'Updating every few seconds'
export const CONNECTING_LABEL = 'Connecting…'
export const RECONNECTING_LABEL = 'Reconnecting…'
export const WAKING_LABEL = 'Server is waking up…'
export const OFFLINE_LABEL = 'Offline'

export type ConnectionTone = 'success' | 'warning' | 'danger'

export interface ConnectionViewInput {
  state: ConnectionState
  mode: ConnectionMode
  /** `navigator.onLine`, read now. The only thing that may say Offline. */
  online: boolean
  /** A read waiting on a cold server. Takes precedence over the transport's wording. */
  waking?: boolean
}

export const connectionView = ({
  state,
  mode,
  online,
  waking = false,
}: ConnectionViewInput): { label: string; tone: ConnectionTone } => {
  if (!online) return { label: OFFLINE_LABEL, tone: 'danger' }
  if (waking) return { label: WAKING_LABEL, tone: 'warning' }
  if (state === 'live')
    return { label: mode === 'sse' ? LIVE_LABEL : POLLING_LABEL, tone: 'success' }
  if (state === 'connecting') return { label: CONNECTING_LABEL, tone: 'warning' }
  return { label: RECONNECTING_LABEL, tone: 'warning' }
}
