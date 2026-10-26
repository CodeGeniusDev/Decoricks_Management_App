'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { IconBell, IconClose, IconSettings } from '@/components/ui/icons'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { usePressScale, useRevealOnMount } from '@/lib/gsap'
import { useNotifications } from '@/hooks/useNotifications'
import { NOTIFICATION_TYPE_LABELS } from '@/lib/notifications/types'
import { maxBox, placeFloating, roomBelow } from '@/lib/ui/placement'
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
 *
 * WHY THE PANEL IS POSITIONED IN JS. It used to be an `absolute right-0` child of
 * the bell, which failed in three ways — the first measured in headless Chromium
 * at the widths the brief names, the other two known from the platform rather
 * than measured here, and stated as such:
 *
 *   1. `right-0` aligned the panel to the BELL's right edge, but the bell is not
 *      at the right of the screen — the account button sits after it inside a
 *      `gap-3 px-4` cluster, roughly 70px in. So the panel's left edge landed at
 *      **-44px on a 320px screen** (-41 at 360, -32 at 390): "Notifications" was
 *      permanently off-screen, and the only reason it looked fine at 430px and up
 *      was that 22rem finally fits in the space left.
 *   2. Its height was `max-h-[75vh]`. `vh` on iOS Safari is the LARGE viewport,
 *      taller than what is actually visible under the browser chrome, so the
 *      bottom of the panel — the push-permission row — could sit below the
 *      visible area with no way to reach it. Not measurable here (no iOS device
 *      in this environment); the fix removes the dependency on `vh` entirely
 *      rather than trying to prove the failure.
 *   3. Being a child of the header, it could never paint above the header's `z-30`
 *      ceiling whatever its own number. It now sits at the same layer as the other
 *      full-width overlays (toasts, drawer).
 *
 * Now: the panel is `fixed` with coordinates from the shared `placeFloating`
 * (flip → clamp, always edge-clear) and a height of the room that is genuinely
 * left under the bell (`roomBelow`), so the list scrolls inside the panel instead
 * of the panel overflowing the phone. It stays where it was in the DOM — directly
 * after the bell — so nothing about tab order or the reveal animation changes; no
 * ancestor of the header has a transform, which is what makes viewport-relative
 * `fixed` safe here. Same rows, same actions, same states: only the geometry, the
 * height rule and the dismissal signal changed.
 */

/** Kept clear of the viewport edge, and the gap under the bell. */
const PANEL_EDGE = 8
const PANEL_GAP = 8
/** 22rem, the width the panel has always had on desktop. */
const PANEL_WIDTH = 352

interface PanelGeometry {
  left: number
  top: number
  width: number
  maxHeight: number
}

export const NotificationBell = () => {
  const [open, setOpen] = useState(false)
  const [geometry, setGeometry] = useState<PanelGeometry | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const bellRef = useRef<HTMLButtonElement>(null)
  usePressScale(bellRef)
  useRevealOnMount(panelRef)

  /*
   * Anchor the panel to the bell through the shared placement rule instead of
   * `absolute right-0`. The height handed to `placeFloating` is the room that is
   * actually left below the bell, which is what makes `bottom` always the fitting
   * side: the panel can never be taller than the space under the header, so it
   * never needs to flip, and never needs `vh`.
   */
  const measure = useCallback(() => {
    const bell = bellRef.current
    if (!bell || typeof window === 'undefined') return
    const r = bell.getBoundingClientRect()
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    const trigger = { left: r.left, top: r.top, width: r.width, height: r.height }
    const available = maxBox(viewport, PANEL_EDGE)
    const width = Math.min(PANEL_WIDTH, available.width)
    const maxHeight = roomBelow(trigger, viewport, PANEL_GAP, PANEL_EDGE)
    const placed = placeFloating(trigger, { width, height: maxHeight }, viewport, {
      preferred: 'bottom',
      align: 'end',
      gap: PANEL_GAP,
      edge: PANEL_EDGE,
    })
    setGeometry({ left: placed.left, top: placed.top, width, maxHeight })
  }, [])

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

  /*
   * Dismiss on outside press or Escape. `pointerdown`, not `mousedown`: on a phone
   * the mouse compatibility events arrive late (or not at all after a scroll),
   * which is why the old listener sometimes needed two taps outside to close.
   * Capture phase, so a `stopPropagation` inside a row cannot eat the dismissal.
   */
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (
        !panelRef.current?.contains(event.target as Node) &&
        !bellRef.current?.contains(event.target as Node)
      ) {
        setOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    // The bell lives in a fixed header, so only a viewport change moves the panel
    // — rotation, split-screen resize, or the mobile URL bar settling.
    const onViewportChange = () => measure()
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('orientationchange', onViewportChange)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('orientationchange', onViewportChange)
    }
  }, [open, measure])

  /*
   * Position the panel before it is painted. Not `useLayoutEffect`: this component
   * is server-rendered as part of the header, and a layout effect there draws a
   * React warning on every page load. Instead the panel is not rendered at all
   * until the geometry exists — one frame (~16ms) of lead time, and no flash of a
   * mispositioned popover — which also means `useRevealOnMount` animates from the
   * panel's real coordinates rather than a temporary one.
   */
  useEffect(() => {
    if (open) {
      measure()
      return
    }
    setGeometry(null)
  }, [open, measure])

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

      {open && geometry && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Notifications"
          className="fixed z-50 flex flex-col overflow-hidden rounded-lg border border-line bg-surface-overlay shadow-lg"
          style={{
            left: geometry.left,
            top: geometry.top,
            width: geometry.width,
            maxHeight: geometry.maxHeight,
          }}
        >
          <div className="flex shrink-0 items-center gap-1 border-b border-line-subtle px-3 py-1.5">
            <h2 className="min-w-0 flex-1 text-sm font-semibold text-decoricks-dark">
              Notifications
            </h2>
            <button
              type="button"
              onClick={() => void markAllRead()}
              disabled={unreadCount === 0}
              className="min-h-11 shrink-0 rounded px-2 text-xs font-medium text-decoricks-brown transition-colors hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-decoricks-brown disabled:cursor-not-allowed disabled:opacity-40"
            >
              Mark all read
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close notifications"
              className="flex h-11 w-9 shrink-0 items-center justify-center rounded text-ink-secondary transition-colors hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-decoricks-brown"
            >
              <IconClose size={16} />
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
                              item.isRead
                                ? 'font-medium text-ink-secondary'
                                : 'font-semibold text-decoricks-dark'
                            }`}
                          >
                            {item.title}
                          </span>
                          {!item.isRead && (
                            <span
                              className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-decoricks-brown"
                              aria-hidden="true"
                            />
                          )}
                        </span>
                        <span className="mt-0.5 block text-xs text-ink-secondary line-clamp-2">
                          {item.message}
                        </span>
                        <span className="mt-1 block text-2xs text-ink-muted">
                          {NOTIFICATION_TYPE_LABELS[item.type]} ·{' '}
                          {relativeTime(item.createdAt, now)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
                {hasMore && (
                  <li className="p-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full"
                      loading={loadMoreLoading}
                      onClick={() => void loadMore()}
                    >
                      Load older
                    </Button>
                  </li>
                )}
              </ul>
            )}
          </div>

          <div className="shrink-0 space-y-2 border-t border-line-subtle px-3 py-2.5">
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
