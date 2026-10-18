'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiJson } from '@/lib/api-client'
import { useRealtimeSync } from '@/lib/sync/useRealtime'
import type { NotificationData, NotificationType } from '@/lib/notifications/types'

/**
 * The client view of one notification. Mirrors `notificationToJSON` on the
 * server (see `@/lib/models/Notifications`) but widened to plain JSON: dates
 * arrive as ISO strings over the wire, `_id` as a string, and `userId` is never
 * sent (the list is always the caller's own). Keeping the shape explicit here —
 * rather than reusing the server `NotificationDoc` — stops the client bundle
 * from pulling in MongoDB types.
 */
export interface NotificationItem {
  _id: string
  type: NotificationType
  title: string
  message: string
  data: NotificationData
  isRead: boolean
  readAt: string | null
  createdAt: string
}

interface ListResponse {
  notifications: NotificationItem[]
  unreadCount: number
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
    hasMore: boolean
  }
}

const PAGE_LIMIT = 20

/**
 * Client state for the notification bell.
 *
 * Responsibilities kept deliberately small and honest:
 *   - Read the caller's own list from `/api/notifications` (the server already
 *     filtered by permission at emit time and by `userId` at read time, so this
 *     hook never touches another user's data and needs no module gate).
 *   - Keep the unread badge live through the Phase 7 real-time layer with a
 *     polling/visibility/reconnect fallback — there is no push here, the server
 *     `notifications` signal is the trigger and this fetch is the payload.
 *   - Optimistic read actions (mark one / mark all) that reconcile against the
 *     server on failure, so the badge and list can never drift into a state the
 *     database disagrees with.
 *
 * A background refresh MERGES by `_id` instead of replacing the list, so new
 * items prepend, already-loaded deeper pages are never yanked away, and the
 * same notification can never appear twice even if a refresh overlaps.
 */
export function useNotifications(active: boolean) {
  const [items, setItems] = useState<NotificationItem[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadMoreLoading, setLoadMoreLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [total, setTotal] = useState(0)

  const pageRef = useRef(1)
  const mountedRef = useRef(true)
  const inFlightRef = useRef<Promise<void> | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const applyResponse = useCallback((res: ListResponse, mode: 'replace' | 'merge') => {
    if (!mountedRef.current) return
    setUnreadCount(res.unreadCount)
    setHasMore(res.pagination.hasMore)
    setTotal(res.pagination.total)
    setItems((prev) => {
      if (mode === 'replace') return res.notifications
      const seen = new Set(res.notifications.map((n) => n._id))
      // New items (top of the fetched window) first, then any already-loaded
      // rows that are not in this window — deduped by id so a refresh overlap
      // cannot create a duplicate.
      const tail = prev.filter((n) => !seen.has(n._id))
      return [...res.notifications, ...tail]
    })
  }, [])

  /** Full (re)load of the first window — used on mount and when the panel opens. */
  const load = useCallback(async () => {
    // Collapse back to the first page: opening the panel should show the newest
    // items, and a stale deeper page is more confusing than a fresh window.
    pageRef.current = 1
    setError(null)
    try {
      const res = await apiJson<ListResponse>(`/api/notifications?limit=${PAGE_LIMIT}`)
      applyResponse(res, 'replace')
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Could not load notifications')
      }
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [applyResponse])

  /**
   * Background refresh: reload the newest window and MERGE. De-duplicated by a
   * shared promise so a burst of events (real-time + focus + online firing
   * together) collapses into a single network round-trip — this is what keeps
   * the badge from double-counting and the list from churning.
   */
  const refresh = useCallback(async () => {
    if (inFlightRef.current) return inFlightRef.current
    const run = (async () => {
      setRefreshing(true)
      try {
        const res = await apiJson<ListResponse>(`/api/notifications?limit=${PAGE_LIMIT}`)
        applyResponse(res, 'merge')
        setError(null)
      } catch {
        // A transient refresh failure is not surfaced over content that already
        // rendered; the next real-time tick or focus retries. Initial load errors
        // are the ones the user sees (via `load`).
      } finally {
        if (mountedRef.current) setRefreshing(false)
        inFlightRef.current = null
      }
    })()
    inFlightRef.current = run
    return run
  }, [applyResponse])

  const loadMore = useCallback(async () => {
    if (!hasMore || loadMoreLoading) return
    setLoadMoreLoading(true)
    const next = pageRef.current + 1
    try {
      const res = await apiJson<ListResponse>(
        `/api/notifications?limit=${PAGE_LIMIT}&page=${next}`
      )
      if (!mountedRef.current) return
      pageRef.current = next
      setUnreadCount(res.unreadCount)
      setHasMore(res.pagination.hasMore)
      setTotal(res.pagination.total)
      // Append deeper pages, guarding against an id that arrived in both the
      // top window (a very recent insert shifts pages) and this page.
      setItems((prev) => {
        const seen = new Set(prev.map((n) => n._id))
        return [...prev, ...res.notifications.filter((n) => !seen.has(n._id))]
      })
    } catch {
      // Leave the list intact; the "Load more" button stays available to retry.
    } finally {
      if (mountedRef.current) setLoadMoreLoading(false)
    }
  }, [hasMore, loadMoreLoading])

  const markRead = useCallback(async (id: string) => {
    const target = items.find((n) => n._id === id)
    if (!target || target.isRead) return
    // Optimistic: flip locally and drop the badge by one, then reconcile.
    setItems((prev) => prev.map((n) => (n._id === id ? { ...n, isRead: true, readAt: new Date().toISOString() } : n)))
    setUnreadCount((c) => Math.max(0, c - 1))
    try {
      await apiJson<NotificationItem>(`/api/notifications/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isRead: true }),
      })
    } catch {
      // Roll the single row back if the server refused.
      setItems((prev) => prev.map((n) => (n._id === id ? { ...n, isRead: false, readAt: null } : n)))
      setUnreadCount((c) => c + 1)
    }
  }, [items])

  const markAllRead = useCallback(async () => {
    if (unreadCount === 0) return
    const before = items
    const beforeCount = unreadCount
    setItems((prev) => prev.map((n) => (n.isRead ? n : { ...n, isRead: true, readAt: new Date().toISOString() })))
    setUnreadCount(0)
    try {
      await apiJson<{ marked: number }>('/api/notifications/read-all', { method: 'POST' })
      // The server broadcasts the `notifications` signal, so every other tab of
      // this user refreshes its badge through the real-time layer too.
    } catch {
      setItems(before)
      setUnreadCount(beforeCount)
    }
  }, [items, unreadCount])

  // Initial load once the shell is ready.
  useEffect(() => {
    if (!active) return
    void load()
  }, [active, load])

  // Live: the server publishes a user-scoped `notifications` signal on every
  // emit and on mark-all-read. `useRealtimeSync` fires only when that module's
  // timestamp advanced, and its transport already falls back to polling when
  // SSE is unavailable (the brief's "polling fallback").
  useRealtimeSync('notifications', refresh, active)

  // Fallbacks the brief asks to be explicit about: refreshing when the tab
  // regains focus or the browser regains connectivity catches the case where
  // the server was asleep / the socket was down while the tab sat in the
  // background. No timers of our own — the coordinator owns polling cadence.
  useEffect(() => {
    if (!active) return
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    const onOnline = () => void refresh()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
    }
  }, [active, refresh])

  return {
    items,
    unreadCount,
    loading,
    refreshing,
    loadMoreLoading,
    error,
    hasMore,
    total,
    reload: load,
    refresh,
    loadMore,
    markRead,
    markAllRead,
  }
}
