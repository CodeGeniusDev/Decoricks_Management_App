'use client'

/**
 * /sync — the offline queue made visible (design §7/§11).
 *
 * Every row the engine knows about, in creation order, with honest status
 * wording ("Pending" is never "Saved") and the three resolution actions the
 * brief requires for anything stuck: Retry, Edit & resubmit (fresh key — a
 * new intended write), Discard (confirm first; audit-logged server-side when
 * the entry had ever reached the server). Counts and "last synced" come from
 * the same pure summarizer the banner and the header chip use, so the three
 * can never disagree.
 */

import React, { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/auth/AuthProvider'
import { PageHeader, PageSection } from '@/components/layout/Page'
import { Metric, MetricGrid } from '@/components/layout/Page'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { Toast } from '@/components/ui/Toast'
import {
  IconAlert,
  IconCheck,
  IconEdit,
  IconRefresh,
  IconSync,
  IconTrash,
} from '@/components/ui/icons'
import { discardQueueEntry, drainQueueNow, retryQueueEntry } from '@/lib/offline/browser'
import { clearAllLocalData, getQueueBackend } from '@/lib/offline/db'
import { QUEUE_STATUS_LABEL, describeQueueEntry, summarizeQueue } from '@/lib/offline/state-view'
import type { QueueEntry } from '@/lib/offline/types'
import { useLastSyncedAt, useOfflineQueue } from '@/hooks/useOfflineQueue'

const STATUS_BADGE: Record<QueueEntry['status'], 'default' | 'success' | 'warning' | 'error'> = {
  pending: 'default',
  syncing: 'default',
  synced: 'success',
  failed: 'error',
  conflict: 'warning',
}

const RESUBMIT_STORAGE_KEY = 'decoricks:offline:resubmit'

const timeAgo = (ms: number): string => {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`
  return new Date(ms).toLocaleString()
}

export default function SyncPage() {
  const { user } = useAuth()
  const router = useRouter()
  const { entries, loading } = useOfflineQueue(user?._id)
  const lastSyncedAt = useLastSyncedAt()

  const [draining, setDraining] = useState(false)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [discardTarget, setDiscardTarget] = useState<QueueEntry | null>(null)
  const [wipeOpen, setWipeOpen] = useState(false)

  const rows = useMemo(() => entries ?? [], [entries])
  const stats = useMemo(() => summarizeQueue(rows), [rows])

  const syncNow = async () => {
    if (!user?._id || draining) return
    setDraining(true)
    try {
      await drainQueueNow(user._id)
    } finally {
      setDraining(false)
    }
  }

  const confirmDiscard = async () => {
    if (!discardTarget) return
    const res = await discardQueueEntry(discardTarget)
    setDiscardTarget(null)
    setToast(
      res.ok
        ? { type: 'success', message: 'Entry discarded. It was never saved to the ledger.' }
        : {
            type: 'error',
            message:
              'Could not record this discard with the server (you may be offline). The entry is kept — try again once connected.',
          }
    )
  }

  const editAndResubmit = async (entry: QueueEntry) => {
    // Stash the payload for the create form and drop the queued row as
    // "replaced". The resubmitted write mints a FRESH key in the form — this
    // one is abandoned on purpose (§7).
    try {
      sessionStorage.setItem(
        RESUBMIT_STORAGE_KEY,
        JSON.stringify({ operation: entry.operation, payload: entry.payload })
      )
    } catch {
      // Private-mode storage failure: fall back to a plain discard+retype.
    }
    const res = await discardQueueEntry(entry, { replace: true })
    if (!res.ok) {
      setToast({
        type: 'error',
        message:
          'Could not hand this entry to the form — the discard audit call failed. Try again online.',
      })
      return
    }
    router.push(entry.operation === 'create_finance' ? '/finance/transactions' : '/budgets')
  }

  const wipeLocalData = async () => {
    await clearAllLocalData()
    setWipeOpen(false)
    setToast({ type: 'success', message: 'Local offline data cleared on this device.' })
  }

  const backend = getQueueBackend()

  return (
    <div className="space-y-5">
      {toast && (
        <div className="fixed top-20 right-4 z-50 max-w-[90vw]">
          <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
        </div>
      )}

      <PageHeader
        title="Sync"
        description="Entries you created while offline live here until the server confirms them."
        actions={
          <>
            <Button onClick={syncNow} loading={draining} disabled={!user?._id}>
              <IconSync size={16} />
              Sync now
            </Button>
            <Button variant="ghost" onClick={() => setWipeOpen(true)}>
              Clear local data
            </Button>
          </>
        }
      />

      <MetricGrid>
        <Metric label="Waiting to sync" value={String(stats.pending)} />
        <Metric
          label="Needs your attention"
          value={String(stats.needsAction)}
          tone={stats.needsAction > 0 ? 'negative' : 'default'}
        />
        <Metric
          label="Synced (last 24h)"
          value={String(stats.syncedRecently)}
          tone={stats.syncedRecently > 0 ? 'positive' : 'default'}
        />
        <Metric
          label="Last synced"
          value={lastSyncedAt ? timeAgo(lastSyncedAt) : 'Never'}
          hint={backend === 'memory' ? 'Private mode — this tab only' : undefined}
        />
      </MetricGrid>

      <PageSection
        title="Queue"
        description="Newest attempts at the bottom; rows stay until resolved."
      >
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<IconCheck size={20} />}
            title="Nothing waiting"
            description="Entries appear here the moment you save one offline and disappear once the server confirms them."
          />
        ) : (
          <div className="space-y-2">
            {rows.map((entry) => (
              <Card key={entry.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={STATUS_BADGE[entry.status]} size="sm">
                        {QUEUE_STATUS_LABEL[entry.status]}
                      </Badge>
                      <span className="text-xs text-ink-muted">
                        {entry.operation === 'create_finance' ? 'Finance entry' : 'Budget'} ·{' '}
                        {timeAgo(entry.createdAt)}
                        {entry.attempts > 0 &&
                          ` · ${entry.attempts} attempt${entry.attempts === 1 ? '' : 's'}`}
                      </span>
                    </div>
                    <p className="mt-1.5 truncate text-sm font-medium text-ink">
                      {describeQueueEntry(entry)}
                    </p>
                    {entry.errorMessage && (
                      <p className="mt-1 flex items-start gap-1.5 text-xs text-status-danger">
                        <IconAlert size={13} className="mt-0.5 shrink-0" />
                        <span>
                          {entry.errorMessage}
                          {entry.nextRetryAt && entry.autoRetry !== false && (
                            <span className="text-ink-muted">
                              {' '}
                              · retrying{' '}
                              {timeAgo(entry.nextRetryAt) === 'just now'
                                ? 'now'
                                : `in ${Math.max(0, Math.round((entry.nextRetryAt - Date.now()) / 1000))}s`}
                            </span>
                          )}
                        </span>
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {(entry.status === 'failed' || entry.status === 'conflict') && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void retryQueueEntry(entry)}
                        >
                          <IconRefresh size={14} />
                          Retry
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void editAndResubmit(entry)}
                        >
                          <IconEdit size={14} />
                          Edit &amp; resubmit
                        </Button>
                      </>
                    )}
                    {entry.status !== 'synced' && entry.status !== 'syncing' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-status-danger hover:bg-status-danger-bg"
                        onClick={() => setDiscardTarget(entry)}
                      >
                        <IconTrash size={14} />
                        Discard
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </PageSection>

      {/* Discard confirmation (§7: never silent). */}
      <Modal
        isOpen={Boolean(discardTarget)}
        onClose={() => setDiscardTarget(null)}
        title="Discard this entry?"
        description={
          discardTarget
            ? `"${describeQueueEntry(discardTarget)}" will be deleted from this device. It was never saved to the ledger.`
            : ''
        }
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDiscardTarget(null)}>
              Keep it
            </Button>
            <Button variant="primary" onClick={() => void confirmDiscard()}>
              Discard entry
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-secondary">
          This cannot be undone. If you meant to change the entry instead, use &ldquo;Edit &amp;
          resubmit&rdquo; to hand it back to the form with a fresh key.
        </p>
      </Modal>

      {/* Manual local wipe (§8 clearing). */}
      <Modal
        isOpen={wipeOpen}
        onClose={() => setWipeOpen(false)}
        title="Clear all local offline data?"
        description="Every queued entry, synced or not, is removed from this device. Anything not yet confirmed by the server will be lost."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setWipeOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void wipeLocalData()}>
              Clear device data
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-secondary">
          Your saved ledger on the server is not affected. Consider pressing &ldquo;Sync now&rdquo;
          first.
        </p>
      </Modal>
    </div>
  )
}
