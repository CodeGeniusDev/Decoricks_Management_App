'use client'

/**
 * OfflineProvider — the client half of Phase 9 Step 3 (design §5–§8, §11).
 *
 * Mounted once inside the authenticated shell. Responsibilities:
 *  - start the sync-engine triggers for the signed-in user (reconnect, focus,
 *    visibility, app-open, Background Sync relay) — idempotent across tabs;
 *  - register the service worker eagerly (the PWA shell needs it even when
 *    push was never enabled — Step 2's lazy registration stays intact for
 *    the push flow, `ensureServiceWorker` is idempotent);
 *  - surface UPDATE_READY from a waiting new SW version as a Refresh prompt
 *    (controlled update, never a mid-session asset swap);
 *  - own the connection/session state the banner renders: offline, or the
 *    engine hit a 401 and the queue is waiting for a fresh login (§7: the
 *    queue is KEPT, nothing is dropped).
 *
 * Nothing here stores financial data — the queue itself lives in Dexie
 * (`src/lib/offline/db.ts`); this file only observes and nudges it.
 */

import React, { createContext, useContext, useEffect, useState } from 'react'
import Link from 'next/link'
import { useAuth } from '@/components/auth/AuthProvider'
import { drainQueueNow, startSyncTriggers, subscribeQueueEvents } from '@/lib/offline/browser'
import { ensureServiceWorker, getServiceWorker } from '@/lib/push/register-service-worker'
import { useOfflineQueueStats } from '@/hooks/useOfflineQueue'
import { IconOffline, IconRefresh } from '@/components/ui/icons'

interface OfflineStatus {
  isOnline: boolean
  /** The engine got a 401 mid-drain: the queue waits for a fresh login. */
  sessionRequired: boolean
}

const OfflineContext = createContext<OfflineStatus>({ isOnline: true, sessionRequired: false })

/** Banner/chip read-model for any shell component (Header uses it). */
export const useOfflineStatus = (): OfflineStatus => useContext(OfflineContext)

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export const OfflineProvider = ({ children }: { children: React.ReactNode }) => {
  const { user } = useAuth()
  const userId = user?._id ?? null

  const [isOnline, setIsOnline] = useState(true)
  const [sessionRequired, setSessionRequired] = useState(false)
  const [updateReady, setUpdateReady] = useState(false)

  // Connection truth for the UI. `navigator.onLine` is the signal the brief
  // allows (§9: not trusted for correctness — the sync attempt is), and it
  // is genuinely the right signal for "show the banner" wording.
  useEffect(() => {
    setIsOnline(navigator.onLine)
    const on = () => setIsOnline(true)
    const off = () => setIsOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  // Engine outcome signals (this tab's bus, incl. cross-tab relays).
  useEffect(
    () =>
      subscribeQueueEvents((event) => {
        if (event.type === 'session-required') setSessionRequired(true)
        // Any later successful activity means the session is back — clear
        // the nag rather than requiring a reload.
        if (event.type === 'drained' && event.synced > 0) setSessionRequired(false)
      }),
    []
  )

  // Per-user engine triggers + eager SW registration + periodic update poll.
  useEffect(() => {
    if (!userId) return
    const teardown = startSyncTriggers(userId)
    void ensureServiceWorker()
    // A sleeping host never fires the SW's own lifecycle; ask for updates on
    // a client timer instead (design §5).
    const timer = setInterval(() => {
      void getServiceWorker()
        .then((reg) => reg?.update())
        .catch(() => undefined)
    }, UPDATE_CHECK_INTERVAL_MS)
    return () => {
      teardown()
      clearInterval(timer)
    }
  }, [userId])

  // Controlled update: the waiting worker told us a new shell version is
  // installed. Refreshing posts SKIP_WAITING so activation is deliberate.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const onMessage = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type === 'UPDATE_READY') {
        setUpdateReady(true)
      }
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [])

  const applyUpdate = async () => {
    try {
      const reg = await navigator.serviceWorker.getRegistration()
      reg?.waiting?.postMessage({ type: 'SKIP_WAITING' })
    } catch {
      // Even without the swap the reload itself picks up the new deploy.
    }
    window.location.reload()
  }

  return (
    <OfflineContext.Provider value={{ isOnline, sessionRequired }}>
      {/* Banner FIRST: it is `sticky` within the page container, so DOM order
          decides where it pins. The update prompt is a fixed overlay. */}
      <OfflineBanner />
      {children}
      {updateReady && (
        <div className="fixed bottom-4 right-4 z-40 max-w-[calc(100vw-2rem)]">
          <div className="flex items-center gap-3 rounded-lg border border-line bg-surface-overlay px-3 py-2.5 shadow-lg">
            <IconRefresh size={16} className="shrink-0 text-decoricks-brown" />
            <p className="text-sm text-ink-secondary">New version available.</p>
            <button
              type="button"
              onClick={() => void applyUpdate()}
              className="rounded-md bg-decoricks-brown px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-decoricks-brown-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setUpdateReady(false)}
              className="text-xs text-ink-muted underline-offset-2 hover:underline"
            >
              Later
            </button>
          </div>
        </div>
      )}
    </OfflineContext.Provider>
  )
}

/**
 * Sticky-under-header status strip. Shown only when it carries information:
 * offline with entries waiting, or a session that must be refreshed before
 * the queue can drain. Never flashes between states (§11: no glitches).
 */
const OfflineBanner = () => {
  const { user } = useAuth()
  const { isOnline, sessionRequired } = useOfflineStatus()
  const { stats } = useOfflineQueueStats(user?._id)

  const hasWork = stats.pending + stats.needsAction > 0
  if (!sessionRequired && (isOnline || !hasWork)) return null

  const message = sessionRequired
    ? 'Your session expired — your queue is safe and will sync after you log in again.'
    : `You're offline — ${stats.pending} ${
        stats.pending === 1 ? 'entry' : 'entries'
      } waiting to sync.`

  return (
    <div
      role="status"
      aria-live="polite"
      className={`sticky top-header z-20 border-b px-4 py-2 text-sm md:px-6 ${
        sessionRequired
          ? 'border-status-warning bg-status-warning-bg text-status-warning'
          : 'border-line bg-surface-sunken text-ink-secondary'
      }`}
      style={{ marginLeft: 'var(--shell-sidebar-offset)' }}
    >
      <div className="flex items-center gap-2">
        <IconOffline size={15} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{message}</span>
        <Link href="/sync" className="shrink-0 font-medium text-decoricks-brown hover:underline">
          Sync queue
        </Link>
        {!sessionRequired && isOnline === false && (
          <span className="sr-only">Entries are stored on this device only.</span>
        )}
        {sessionRequired && (
          <button
            type="button"
            onClick={() => void drainQueueNow(user?._id ?? '')}
            className="shrink-0 rounded border border-line-strong px-2 py-0.5 text-xs font-medium text-ink-secondary transition-colors hover:bg-surface-sunken"
          >
            Retry
          </button>
        )}
      </div>
    </div>
  )
}
