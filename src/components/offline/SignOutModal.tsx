'use client'

/**
 * SignOutModal — wipe-on-logout decision point (design §8: "Clearing").
 *
 * Signing out on a device that still holds unsynced queue entries must never
 * silently destroy them and never silently keep them either. The user gets
 * three explicit choices:
 *
 *  1. "Sync now & sign out"   — attempt one drain, then sign out whatever
 *     happens (unresolved rows stay in the queue, user-scoped, and sync on
 *     the next login on this device);
 *  2. "Discard & sign out"    — audit-log entries that had reached the server
 *     (per-entry, best effort), then WIPE the whole local offline DB — the
 *     §8 data-protection guarantee for a shared or handed-over device;
 *  3. "Sign out keeping queue" — leave the user-scoped queue intact; it is
 *     invisible to the next user (filtered by userId) and resyncs later.
 *
 * An empty queue skips this modal entirely — normal sign-out, no friction.
 */

import React, { useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { IconAlert } from '@/components/ui/icons'
import { useAuth } from '@/components/auth/AuthProvider'
import { useRouter } from 'next/navigation'
import { discardQueueEntry, drainQueueNow } from '@/lib/offline/browser'
import { clearAllLocalData } from '@/lib/offline/db'
import { useOfflineQueue } from '@/hooks/useOfflineQueue'

interface SignOutModalProps {
  isOpen: boolean
  onClose: () => void
}

export const SignOutModal = ({ isOpen, onClose }: SignOutModalProps) => {
  const { user, signOut } = useAuth()
  const router = useRouter()
  const { entries } = useOfflineQueue(user?._id)
  const [busy, setBusy] = useState<null | 'sync' | 'discard' | 'keep'>(null)
  const [error, setError] = useState<string | null>(null)

  const finish = async () => {
    await signOut()
    router.replace('/login')
    router.refresh()
  }

  const handleSyncNow = async () => {
    if (busy || !user?._id) return
    setBusy('sync')
    try {
      // One honest attempt; unresolved rows simply ride along in the queue.
      await drainQueueNow(user._id)
      await finish()
    } catch {
      setError('Sign-out failed. Your queue is untouched — try again.')
      setBusy(null)
    }
  }

  const handleDiscard = async () => {
    if (busy || !user?._id) return
    setBusy('discard')
    try {
      // Entries that EVER reached the server get their audit marker first
      // (§8.3); a failed audit call offline must not block the wipe the user
      // explicitly asked for, but we tell them rows were dropped un-logged.
      const rows = entries ?? []
      let auditMissed = false
      for (const entry of rows) {
        const res = await discardQueueEntry(entry)
        if (!res.ok) auditMissed = true
      }
      await clearAllLocalData()
      if (auditMissed) {
        setError('Some discards were not recorded server-side. Local data was cleared anyway.')
      }
      await finish()
    } catch {
      setError('Sign-out failed. Your queue is untouched — try again.')
      setBusy(null)
    }
  }

  const handleKeep = async () => {
    if (busy) return
    setBusy('keep')
    try {
      await finish()
    } catch {
      setError('Sign-out failed. Try again.')
      setBusy(null)
    }
  }

  const pendingCount = (entries ?? []).filter((e) => e.status !== 'synced').length

  return (
    <Modal
      isOpen={isOpen}
      onClose={busy ? () => undefined : onClose}
      dismissible={!busy}
      title="You have unsynced entries"
      description={`${pendingCount} ${
        pendingCount === 1 ? 'entry is' : 'entries are'
      } still waiting on this device. What should happen to them before you sign out?`}
      size="sm"
      footer={
        <div className="flex flex-col gap-2">
          <Button onClick={handleSyncNow} disabled={Boolean(busy)} loading={busy === 'sync'}>
            Sync now & sign out
          </Button>
          <Button
            variant="secondary"
            onClick={handleDiscard}
            disabled={Boolean(busy)}
            loading={busy === 'discard'}
          >
            Discard them & sign out
          </Button>
          <Button
            variant="ghost"
            onClick={handleKeep}
            disabled={Boolean(busy)}
            loading={busy === 'keep'}
          >
            Sign out keeping the queue
          </Button>
          {!busy && (
            <button
              type="button"
              onClick={onClose}
              className="mt-1 text-sm text-ink-muted transition-colors hover:text-ink"
            >
              Cancel
            </button>
          )}
        </div>
      }
    >
      <div className="space-y-2">
        <p className="text-sm text-ink-secondary">
          Entries are stored only on this device and belong to your account — the next person to
          sign in here will not see or sync them.
        </p>
        {error && (
          <p className="flex items-start gap-2 text-sm text-status-danger" role="alert">
            <IconAlert size={15} className="mt-0.5 shrink-0" />
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
