'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { IconBell } from '@/components/ui/icons'
import { usePressScale } from '@/lib/gsap'
import {
  disablePush,
  enablePush,
  getPushStatus,
  resyncPushSubscription,
  type PushStatus,
} from '@/lib/push/push-client'

/**
 * Web Push on/off control (design §10, decision D7).
 *
 * Every rule the brief sets for OS-level notifications is honoured HERE rather
 * than scattered across pages:
 *   - Permission is requested only inside a click handler (`enablePush` calls
 *     `Notification.requestPermission()` synchronously from this button).
 *     Nothing here ever prompts on load.
 *   - Denied / unsupported / not-configured each get their own honest copy so a
 *     user understands WHY there are no desktop alerts, instead of a silent
 *     nothing. The in-app bell keeps working regardless — push is an accelerator.
 *   - `getPushStatus()` on mount only READS state (it never registers a worker
 *     or prompts); the worker is registered lazily inside `enablePush`.
 *
 * `compact` is the footer style used inside the bell dropdown; the full style is
 * used on the Settings → Notifications tab, where the platform caveats belong.
 */

interface Props {
  compact?: boolean
}

const failureCopy: Record<string, string> = {
  'permission-denied': 'Notifications are blocked in your browser settings. Allow them for this site, then try again.',
  'permission-dismissed': 'You dismissed the permission prompt, so desktop alerts stay off. You can enable them any time.',
  'sw-unavailable': 'Your browser could not start the background worker needed for alerts. Reload and try again.',
  'not-configured': 'The owner has not enabled push keys for this deployment yet, so desktop alerts are unavailable.',
  'subscribe-failed': 'The browser refused the push subscription. This can happen on a flaky connection — try again.',
  'store-failed': 'Your device subscribed, but the server could not save it. Check your connection and try again.',
  'insecure-context': 'Desktop alerts need HTTPS (or localhost). You are on an insecure connection.',
  unsupported: 'This browser does not support Web Push. In-app notifications still work.',
}

export const PushEnableControl = ({ compact = false }: Props) => {
  const [status, setStatus] = useState<PushStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const busyRef = useRef(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  usePressScale(buttonRef)

  const probe = useCallback(async () => {
    try {
      setStatus(await getPushStatus())
    } catch {
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    void probe()
  }, [probe])

  // If the browser rotates our subscription (endpoint expiry), re-establish it
  // silently when permission is already granted — `resyncPushSubscription` never
  // prompts and never registers a fresh worker, so this cannot violate the
  // "only on a user gesture" rule.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const onMessage = (event: MessageEvent) => {
      if ((event.data as { type?: string })?.type === 'PUSH_RESUBSCRIBE') {
        void resyncPushSubscription().then(probe)
      }
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [probe])

  const onEnable = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setMessage(null)
    const result = await enablePush()
    if (!result.ok && result.reason) setMessage(failureCopy[result.reason] ?? 'Could not enable alerts.')
    await probe()
    setBusy(false)
    busyRef.current = false
  }

  const onDisable = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setMessage(null)
    await disablePush()
    await probe()
    setBusy(false)
    busyRef.current = false
  }

  // Still probing capability — show a calm placeholder, never a misleading button.
  if (!status) {
    return compact ? null : <p className="text-sm text-ink-muted">Checking this device…</p>
  }

  if (status.active) {
    return (
      <div className={compact ? 'flex items-center gap-2' : 'space-y-2'}>
        {!compact && <Badge variant="success">Desktop alerts on</Badge>}
        <p className={compact ? 'text-xs text-ink-muted' : 'text-sm text-ink-secondary'}>
          {compact ? 'Desktop alerts are on for this device.' : 'You will get an alert even when the app is closed, for as long as this device stays registered.'}
        </p>
        <Button ref={buttonRef} variant="ghost" size="sm" disabled={busy} onClick={() => void onDisable()}>
          {compact ? 'Turn off' : 'Turn off desktop alerts'}
        </Button>
      </div>
    )
  }

  // Denied at the browser level: no button can fix it, so explain instead.
  if (status.permission === 'denied') {
    return (
      <p className={`text-xs text-status-danger ${compact ? '' : 'text-sm'}`}>
        {failureCopy['permission-denied']}
      </p>
    )
  }

  // Device/browser can't do it, or the server has no keys: state it plainly.
  if (!status.supported) {
    return (
      <p className={`text-xs text-ink-muted ${compact ? '' : 'text-sm'}`}>{failureCopy.unsupported}</p>
    )
  }
  if (!status.configured) {
    return (
      <p className={`text-xs text-ink-muted ${compact ? '' : 'text-sm'}`}>{failureCopy['not-configured']}</p>
    )
  }

  return (
    <div className={compact ? 'flex items-center gap-2' : 'space-y-2'}>
      <Button
        ref={buttonRef}
        variant={compact ? 'ghost' : 'outline'}
        size="sm"
        disabled={busy}
        onClick={() => void onEnable()}
      >
        <IconBell size={14} className="mr-1 inline-block align-[-2px]" />
        {busy ? 'Enabling…' : 'Enable desktop alerts'}
      </Button>
      {!compact && (
        <p className="text-xs text-ink-muted">
          You will be asked for browser permission now — never automatically. On iPhone/iPad this
          only works once the app is added to the Home Screen, and alerts can be late while the
          free host is asleep; the in-app bell is always the source of truth.
        </p>
      )}
      {message && (
        <p className="text-xs text-status-danger" role="alert">
          {message}
        </p>
      )}
    </div>
  )
}
