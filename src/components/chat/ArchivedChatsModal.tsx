'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Skeleton } from '@/components/ui/Skeleton'
import { IconArchive, IconClose, IconRefresh } from '@/components/ui/icons'
import { apiFetch } from '@/lib/api-client'
import type { ChatChannel } from './types'

interface ArchivedChatsModalProps {
  isOpen: boolean
  onClose: () => void
  /** Open a closed room read-only in the main panel. */
  onOpenRoom: (channel: ChatChannel) => void
  /** Performs the restore and its own feedback; resolves true on success.
   *  Kept in the page so every channel mutation lives in one place. */
  onRestore: (id: string) => Promise<boolean>
}

interface Envelope<T> {
  success: boolean
  data?: T
  error?: { message?: string }
}

const pluralize = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`

const formatDay = (iso?: string | null): string | null => {
  if (!iso) return null
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return null
  return new Date(ts).toLocaleDateString('en-PK', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/**
 * Archived Chats.
 *
 * The room is fetched while the dialog is open and refetched after a restore, so
 * the list can never drift from MongoDB behind the user's back; the fetch is
 * keyed on `isOpen` so a closed dialog holds no request and no polling thread.
 *
 * Filtering happens on the already-fetched rows rather than the server: the
 * Founder-only archive list is a handful of closed rooms, not a pagulated
 * collection, and a `q` parameter here would only add a query path that the
 * existing `{ isArchived, updatedAt }` index cannot serve better than a sort.
 */
export function ArchivedChatsModal({
  isOpen,
  onClose,
  onOpenRoom,
  onRestore,
}: ArchivedChatsModalProps) {
  const [rooms, setRooms] = useState<ChatChannel[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [restoringId, setRestoringId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch('/api/chat/channels?archived=true')
      const body = (await res.json().catch(() => null)) as Envelope<ChatChannel[]> | null
      if (!body?.success || !body.data) throw new Error(body?.error?.message ?? 'Request failed')
      setRooms(body.data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load archived channels')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isOpen) return
    setQuery('')
    void load()
  }, [isOpen, load])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return rooms
    return rooms.filter(
      (c) =>
        c.name.toLowerCase().includes(needle) ||
        (c.description ?? '').toLowerCase().includes(needle)
    )
  }, [rooms, query])

  const restore = async (channel: ChatChannel) => {
    if (restoringId) return
    setRestoringId(channel._id)
    const ok = await onRestore(channel._id)
    setRestoringId(null)
    // Only a successful restore leaves the list; a failed one must stay, because
    // the room is still archived and pretending otherwise would hide the error.
    if (ok) setRooms((prev) => prev.filter((c) => c._id !== channel._id))
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Archived Chats"
      description="Closed channels and their full history. Nothing here was deleted."
      size="md"
      footer={
        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>
            <IconClose className="mr-1 h-4 w-4" /> Close
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {rooms.length > 0 && (
          <Input
            label="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by channel name"
            aria-label="Search archived channels"
          />
        )}

        {loading ? (
          <div className="space-y-2" aria-busy="true">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} variant="rect" className="h-14 w-full" />
            ))}
          </div>
        ) : error ? (
          <ErrorState
            title="Could not load archived channels"
            description={error}
            action={{ label: 'Try again', onClick: () => void load() }}
          />
        ) : rooms.length === 0 ? (
          <EmptyState
            icon={<IconArchive className="h-5 w-5" />}
            title="No archived channels"
            description="When the Founder archives a channel it moves here instead of disappearing."
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<IconArchive className="h-5 w-5" />}
            title="No matches"
            description={`Nothing archived matches "${query.trim()}".`}
            action={{ label: 'Clear search', onClick: () => setQuery('') }}
          />
        ) : (
          <ul className="space-y-1.5">
            {visible.map((c) => {
              const day = formatDay(c.archivedAt ?? c.updatedAt)
              const busy = restoringId === c._id
              return (
                <li
                  key={c._id}
                  className="flex items-center gap-3 rounded-lg border border-line-subtle px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">#{c.name}</p>
                    <p className="truncate text-xs text-ink-muted">
                      {pluralize(c.messageCount ?? 0, 'message', 'messages')}
                      {day ? ` · archived ${day}` : ''}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => onOpenRoom(c)}>
                    View
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy}
                    disabled={restoringId !== null && !busy}
                    onClick={() => void restore(c)}
                    title={`Restore #${c.name} to the channel list`}
                  >
                    {!busy && <IconRefresh className="mr-1 h-4 w-4" />}
                    Restore
                  </Button>
                </li>
              )
            })}
          </ul>
        )}

        {!loading && !error && rooms.length > 0 && (
          <p className="text-xs text-ink-muted">
            Restoring a channel returns it to the list for everyone; the messages never left.
          </p>
        )}
      </div>
    </Modal>
  )
}
