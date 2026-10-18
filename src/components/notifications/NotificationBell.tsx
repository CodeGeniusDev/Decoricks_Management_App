'use client'

import React, { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { IconBell, IconSettings } from '@/components/ui/icons'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { usePressScale, useRevealOnMount } from '@/lib/gsap'
import { useNotifications } from '@/hooks/useNotifications'
import { NOTIFICATION_TYPE_LABELS } from '@/lib/notifications/types'
import { NotificationGlyph, relativeTime } from './notification-visuals'
import { PushEnableControl } from './PushEnableControl'

/**
 * The notification bell. Always present in the header; the unread badge is live
 * via `useNotifications` (Phase 7 signal + focus/reconnect fallbacks). The
 * dropdown is the in-app center the brief asks for: read/unread rows, mark-all-
 * read, a link to the related record, "load more" pagination, and the door to
 * per-user preferences and desktop alerts.
 *
 * Deliberately closed on first paint (SSR-safe: no date-derived text renders
 * until the user opens it client-side), so there is never a hydration mismatch
 * from relative-time strings computed against the wall clock.
 */

export const NotificationBell = () => {
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const bellRef = useRef<HTMLButtonElement>(null)
  usePressScale(bellRef)
  useRevealOnMount(panelRef)

  const {
    items,
    unreadCount,
    loading,
    loadMoreLoading,
    error,
    hasMore,
    reload,
    refresh,
    loadMore,
    markRead,
    markAllRead,
  } = useNotifications(true)

  // Ticking "now" so a row that said "just now" becomes "2m ago" while the
  // panel is open — refreshed only while open, and cleaned up on close/unmount.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [open])

  // Dismiss on outside click or Escape, mirroring the account menu behaviour.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node) && !bellRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const router = useRouter()

  const onToggle = () => {
    setOpen((v) => {
      const next = !v
      // Opening should show the newest items; a quiet refresh keeps the badge and
      // list honest without a full loading flash.
      if (next) void refresh()
      return next
    })
  }

  const openItem = (id: string, link?: string) => {
    void markRead(id)
    if (link) {
      setOpen(false)
      router.push(link)
    }
  }

  return (
    <div className="relative">
      <button
        ref={bellRef}
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        className="relative flex h-11 w-11 items-center justify-center rounded text-ink-secondary transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown"
      >
        <IconBell size={20} />
        {unreadCount > 0 && (
          <span
            className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-decoricks-brown px-1 text-2xs font-bold leading-none text-white tabular-nums"
            aria-hidden="true"
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-[calc(100%+0.5rem)] z-40 flex max-h-[75vh] w-[min(92vw,22rem)] flex-col overflow-hidden rounded-lg border border-line bg-surface-overlay shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-line-subtle px-3 py-2.5">
            <h2 className="text-sm font-semibold text-decoricks-dark">Notifications</h2>
            <button
              type="button"
              onClick={() => void markAllRead()}
              disabled={unreadCount === 0}
              className="min-h-11 rounded px-2 text-xs font-medium text-decoricks-brown transition-colors hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-decoricks-brown disabled:cursor-not-allowed disabled:opacity-40"
            >
              Mark all read
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <div className="space-y-2 p-3">
                <Skeleton variant="rect" className="h-12" />
                <Skeleton variant="rect" className="h-12" />
                <Skeleton variant="rect" className="h-12" />
              </div>
            ) : error ? (
              <ErrorState
                title="Could not load notifications"
                description={error}
                action={{ label: 'Retry', onClick: () => void reload() }}
              />
            ) : items.length === 0 ? (
              <EmptyState title="No notifications" description="You're all caught up." />
            ) : (
              <ul className="divide-y divide-line-subtle">
                {items.map((item) => (
                  <li key={item._id}>
                    <button
                      type="button"
                      onClick={() => openItem(item._id, item.data.link)}
                      className={`flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-decoricks-brown ${
                        item.isRead ? 'opacity-80' : ''
                      }`}
                    >
                      <NotificationGlyph type={item.type} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span
                            className={`truncate text-sm ${
                              item.isRead ? 'font-medium text-ink-secondary' : 'font-semibold text-decoricks-dark'
                            }`}
                          >
                            {item.title}
                          </span>
                          {!item.isRead && (
                            <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-decoricks-brown" aria-hidden="true" />
                          )}
                        </span>
                        <span className="mt-0.5 block text-xs text-ink-secondary line-clamp-2">{item.message}</span>
                        <span className="mt-1 block text-2xs text-ink-muted">
                          {NOTIFICATION_TYPE_LABELS[item.type]} · {relativeTime(item.createdAt, now)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
                {hasMore && (
                  <li className="p-2">
                    <Button variant="ghost" size="sm" className="w-full" loading={loadMoreLoading} onClick={() => void loadMore()}>
                      Load older
                    </Button>
                  </li>
                )}
              </ul>
            )}
          </div>

          <div className="space-y-2 border-t border-line-subtle px-3 py-2.5">
            <PushEnableControl compact />
            <Link
              href="/settings?tab=notifications"
              onClick={() => setOpen(false)}
              className="flex min-h-11 items-center gap-2 rounded px-2 text-xs font-medium text-ink-secondary transition-colors hover:bg-surface-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-decoricks-brown"
            >
              <IconSettings size={14} />
              Notification settings
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}
