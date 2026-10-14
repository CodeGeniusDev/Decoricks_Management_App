'use client'

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Textarea } from '@/components/ui/Textarea'
import { Skeleton } from '@/components/ui/Skeleton'
import { IconEdit, IconTrash, IconCheck, IconClose, IconAlert } from '@/components/ui/icons'
import type { ChatMessage } from './types'

interface MessageListProps {
  messages: ChatMessage[]
  currentUserId: string
  loading: boolean
  hasMoreOlder: boolean
  loadingOlder: boolean
  onLoadOlder: () => void
  /** Whether a message may be edited/deleted by the current user. Server is the
   *  authority; the client shows the affordance and a 403 explains a closed window. */
  canModify: (m: ChatMessage) => boolean
  onEdit: (id: string, content: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onRetry: (m: ChatMessage) => void
}

const initials = (name: string) => name.trim().charAt(0).toUpperCase() || '?'

const formatTime = (dateStr: string): string =>
  new Date(dateStr).toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' })

/**
 * Message transcript.
 *
 * Two behaviours matter most here and are the usual sources of "chat feels
 * janky":
 *  - Loading older messages on scroll-up must not jump the view. We capture the
 *    scroll height before prepending and, in a layout effect (before paint),
 *    shift `scrollTop` by the height delta so the reader's eye stays on the same
 *    message across the DOM change.
 *  - New messages should pull the reader to the bottom only when they were
 *    already near the bottom. If the reader has scrolled up to look at history,
 *    an incoming message must not yank them down — instead a "new messages"
 *    affordance appears.
 */
export function MessageList({
  messages,
  currentUserId,
  loading,
  hasMoreOlder,
  loadingOlder,
  onLoadOlder,
  canModify,
  onEdit,
  onDelete,
  onRetry,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const prevHeightRef = useRef(0)
  const prevFirstIdRef = useRef<string | null>(null)
  const prevCountRef = useRef(0)
  const stickToBottomRef = useRef(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [newBelow, setNewBelow] = useState(0)

  // Track whether the reader is anchored near the bottom; drives both the
  // auto-scroll decision and the "jump to latest" pill.
  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const nearBottom = distanceFromBottom < 80
    stickToBottomRef.current = nearBottom
    if (nearBottom && newBelow !== 0) setNewBelow(0)

    // Near the top with older history available → load a page.
    if (el.scrollTop < 48 && hasMoreOlder && !loadingOlder) {
      prevHeightRef.current = el.scrollHeight
      onLoadOlder()
    }
  }, [hasMoreOlder, loadingOlder, onLoadOlder, newBelow])

  // After messages change, in one pass before paint:
  //  - a PREPEND (older page loaded — the first id changed) restores the visual
  //    anchor by shifting scrollTop by the height delta, so the reader never
  //    jumps.
  //  - an APPEND (live tail / own send) follows the bottom only when the reader
  //    was already near it; otherwise a "new messages" pill counts them up.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const firstId = messages.length ? messages[0]._id || messages[0].tempId || '' : ''
    const countBefore = prevCountRef.current
    const prepended =
      countBefore > 0 &&
      messages.length > countBefore &&
      prevFirstIdRef.current !== null &&
      firstId !== prevFirstIdRef.current

    if (prepended) {
      el.scrollTop = el.scrollHeight - prevHeightRef.current
    } else if (messages.length > countBefore) {
      const added = messages.length - countBefore
      if (stickToBottomRef.current) {
        el.scrollTop = el.scrollHeight
      } else {
        setNewBelow((n) => n + added)
      }
    } else if (countBefore === 0) {
      // First paint of a channel: start at the bottom.
      el.scrollTop = el.scrollHeight
      stickToBottomRef.current = true
    }

    prevHeightRef.current = el.scrollHeight
    prevCountRef.current = messages.length
    prevFirstIdRef.current = firstId
  }, [messages])

  // Jump-to-latest when a new message arrives while scrolled up.
  const jumpToLatest = () => {
    const el = containerRef.current
    if (!el) return
    stickToBottomRef.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setNewBelow(0)
  }

  const startEdit = (m: ChatMessage) => {
    setEditingId(m._id)
    setDraft(m.content)
  }
  const cancelEdit = () => {
    setEditingId(null)
    setDraft('')
  }
  const commitEdit = async (id: string) => {
    if (!draft.trim() || saving) return
    setSaving(true)
    try {
      await onEdit(id, draft.trim())
      cancelEdit()
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex-1 space-y-4 overflow-y-auto p-4" aria-busy="true">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} variant="rect" className="h-12 w-3/4" />
        ))}
      </div>
    )
  }

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto p-4 space-y-3"
      >
        {loadingOlder && (
          <div className="flex justify-center py-2">
            <Skeleton variant="rect" className="h-8 w-40" />
          </div>
        )}

        {messages.length === 0 ? (
          <p className="py-10 text-center text-sm text-ink-muted">
            No messages yet. Start the conversation.
          </p>
        ) : (
          messages.map((message) => {
            const own = message.senderId === currentUserId
            const isDeleted = message.isDeleted
            const editing = editingId === message._id
            return (
              <div
                key={message._id || message.tempId}
                className={`flex items-end gap-2 ${own ? 'justify-end' : 'justify-start'}`}
              >
                {!own && !message.isSystem && (
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-decoricks-brown text-sm font-semibold text-decoricks-light">
                    {initials(message.senderName)}
                  </div>
                )}

                <div
                  className={`flex max-w-[78%] flex-col gap-1 ${own ? 'items-end' : 'items-start'}`}
                >
                  {!own && !message.isSystem && (
                    <span className="px-1 text-xs font-semibold text-ink-muted">
                      {message.senderName}
                    </span>
                  )}

                  <div
                    className={`rounded-lg px-3 py-2 text-sm ${
                      isDeleted
                        ? 'border border-dashed border-line-subtle bg-surface-sunken italic text-ink-muted'
                        : own
                          ? 'bg-decoricks-brown text-decoricks-light'
                          : 'border border-line-subtle bg-surface-sunken text-ink-secondary'
                    }`}
                  >
                    {editing ? (
                      <div className="w-56 max-w-full">
                        <Textarea
                          rows={2}
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          className="mb-2 bg-decoricks-light text-decoricks-dark"
                        />
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="primary"
                            loading={saving}
                            onClick={() => commitEdit(message._id)}
                          >
                            <IconCheck className="mr-1 h-4 w-4" /> Save
                          </Button>
                          <Button size="sm" variant="outline" onClick={cancelEdit}>
                            <IconClose className="mr-1 h-4 w-4" /> Cancel
                          </Button>
                        </div>
                      </div>
                    ) : isDeleted ? (
                      <p>This message was deleted.</p>
                    ) : (
                      <p className="whitespace-pre-wrap break-words">{message.content}</p>
                    )}

                    {!editing && !isDeleted && (
                      <div
                        className={`mt-1 flex items-center gap-2 text-2xs ${
                          own ? 'text-decoricks-light/70' : 'text-ink-muted'
                        }`}
                      >
                        <span>{formatTime(message.createdAt)}</span>
                        {message.editedAt && <span>· edited</span>}
                        {own && message.status === 'sending' && <span>· sending…</span>}
                        {own && message.status === 'failed' && (
                          <button
                            type="button"
                            onClick={() => onRetry(message)}
                            className="inline-flex items-center gap-1 font-semibold text-status-warning underline underline-offset-2"
                          >
                            <IconAlert className="h-3 w-3" /> Failed · Retry
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {!editing && canModify(message) && (
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => startEdit(message)}
                        aria-label="Edit message"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-sunken hover:text-ink-secondary"
                      >
                        <IconEdit className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete(message._id)}
                        aria-label="Delete message"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-sunken hover:text-status-danger"
                      >
                        <IconTrash className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      {newBelow > 0 && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-line bg-decoricks-brown px-4 py-2 text-xs font-semibold text-decoricks-light shadow-sm"
        >
          {newBelow} new message{newBelow > 1 ? 's' : ''} ↓
        </button>
      )}
    </div>
  )
}
