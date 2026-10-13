'use client'

import { useCallback, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Textarea } from '@/components/ui/Textarea'
import { Badge } from '@/components/ui/Badge'
import { apiFetch } from '@/lib/api-client'

/**
 * TaskDetail — the "Discussion" panel that lives inside the card modal.
 *
 * Kept separate from the page file so the drag layer, edit form and detail
 * panel can each grow without stepping on each other. All three talk to the
 * same endpoints the board already uses.
 *
 * The activity feed is intentionally dumb text: `moved`, `assigned`,
 * `completed`, `reopened`, `archived`, `edited`, `created`, `commented` —
 * each with a small human summary rendered from the changes blob the server
 * wrote. We do not attempt to translate column/object ids here — the API
 * layer already knows the actor names, so a future enhancement is to
 * pre-render `actorName` server-side; for now the id chip is honest.
 */

export interface CommentDto {
  _id: string
  taskId: string
  authorId: string
  body: string | null
  editedAt: string | null
  isDeleted: boolean
  deletedAt?: string | null
  createdAt: string
  updatedAt: string
}

export interface ActivityDto {
  _id: string
  kind: string
  actorId: string
  changes?: Record<string, unknown>
  at: string
}

interface TaskDetailProps {
  taskId: string
  comments: CommentDto[]
  activity: ActivityDto[]
  /** Minutes resolved from Business Settings; the panel uses it to gate edit/delete UI. */
  editWindowMinutes: number
  currentUserId: string | undefined
  canModerate: boolean
  onCommentsChange: (next: CommentDto[]) => void
  onNotice: (kind: 'success' | 'error' | 'warning' | 'info', message: string) => void
}

const ACTION_LABELS: Record<string, string> = {
  created: 'created the task',
  assigned: 'updated assignees',
  moved: 'moved the card',
  completed: 'marked as done',
  reopened: 'reopened',
  archived: 'archived the card',
  edited: 'edited details',
  commented: 'commented',
}

/**
 * A comment is editable by its author if it is still inside the window.
 * Once outside, only a moderator (`tasks.editOthers`, Founder by default)
 * can change it. The server enforces the same rule; this is UI courtesy.
 */
function authorMayEdit(
  comment: CommentDto,
  userId: string | undefined,
  windowMinutes: number,
  now: number
): boolean {
  if (!userId) return false
  if (comment.authorId !== userId) return false
  if (comment.isDeleted) return false
  const createdMs = new Date(comment.createdAt).getTime()
  return now - createdMs <= windowMinutes * 60_000
}

function relTime(iso: string, now: number): string {
  const diff = Math.max(0, now - new Date(iso).getTime())
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}

function shortId(id: string | undefined): string {
  if (!id) return 'system'
  return id.slice(-6)
}

export function TaskDetailPanel(props: TaskDetailProps) {
  const {
    taskId,
    comments,
    activity,
    editWindowMinutes,
    currentUserId,
    canModerate,
    onCommentsChange,
    onNotice,
  } = props

  const [composer, setComposer] = useState('')
  const [posting, setPosting] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editBody, setEditBody] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)

  const post = useCallback(async () => {
    const body = composer.trim()
    if (!body) return
    setPosting(true)
    try {
      const res = await apiFetch(`/api/tasks/${taskId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json?.error?.message ?? 'Comment failed')
      const created = json.data as CommentDto
      onCommentsChange([...comments, created])
      setComposer('')
      onNotice('success', 'Comment added')
    } catch (err) {
      onNotice('error', err instanceof Error ? err.message : 'Comment failed')
    } finally {
      setPosting(false)
    }
  }, [composer, taskId, comments, onCommentsChange, onNotice])

  const startEdit = (c: CommentDto) => {
    setEditingId(c._id)
    setEditBody(c.body ?? '')
  }

  const saveEdit = useCallback(
    async (id: string) => {
      const body = editBody.trim()
      if (!body) return
      setSavingEdit(true)
      try {
        const res = await apiFetch(`/api/tasks/${taskId}/comments/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ body }),
        })
        const json = await res.json()
        if (!res.ok || !json.success) throw new Error(json?.error?.message ?? 'Update failed')
        const updated = json.data as CommentDto
        onCommentsChange(comments.map((c) => (c._id === id ? updated : c)))
        setEditingId(null)
        setEditBody('')
        onNotice('success', 'Comment updated')
      } catch (err) {
        onNotice('error', err instanceof Error ? err.message : 'Update failed')
      } finally {
        setSavingEdit(false)
      }
    },
    [editBody, taskId, comments, onCommentsChange, onNotice]
  )

  const remove = useCallback(
    async (id: string) => {
      if (!window.confirm('Delete this comment? The row stays in the audit trail with its body redacted.'))
        return
      try {
        const res = await apiFetch(`/api/tasks/${taskId}/comments/${id}`, { method: 'DELETE' })
        const json = await res.json()
        if (!res.ok || !json.success) throw new Error(json?.error?.message ?? 'Delete failed')
        const updated = json.data as CommentDto
        onCommentsChange(comments.map((c) => (c._id === id ? updated : c)))
        onNotice('success', 'Comment deleted')
      } catch (err) {
        onNotice('error', err instanceof Error ? err.message : 'Delete failed')
      }
    },
    [taskId, comments, onCommentsChange, onNotice]
  )

  // Snapshot of "now" for the whole render pass so all comments agree on the
  // window boundary — otherwise two cards 30ms apart can flip state and cause
  // a hydration mismatch in the panel.
  const now = Date.now()

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-2 text-sm font-semibold text-decoricks-dark">Discussion</h3>
        <ul className="flex flex-col gap-2">
          {comments.length === 0 ? (
            <li className="rounded border border-dashed border-line-subtle px-3 py-3 text-center text-xs text-ink-muted">
              No comments yet.
            </li>
          ) : (
            comments.map((c) => {
              const isAuthor = currentUserId === c.authorId
              const withinWindow = authorMayEdit(c, currentUserId, editWindowMinutes, now)
              const canEdit = !c.isDeleted && (withinWindow || canModerate)
              const canDelete = !c.isDeleted && (isAuthor || canModerate)
              const showEditBox = editingId === c._id
              return (
                <li
                  key={c._id}
                  className="rounded-lg border border-line-subtle bg-surface-raised px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2 text-xs text-ink-muted">
                    <span className="tabular-nums">
                      {isAuthor ? 'You' : `User ${shortId(c.authorId)}`}
                      {c.editedAt && ' · edited'}
                      {c.isDeleted && ' · deleted'}
                    </span>
                    <span title={c.createdAt}>{relTime(c.createdAt, now)}</span>
                  </div>
                  {c.isDeleted ? (
                    <p className="mt-1 text-sm italic text-ink-muted">
                      This comment was deleted.
                    </p>
                  ) : showEditBox ? (
                    <div className="mt-2 flex flex-col gap-2">
                      <Textarea
                        value={editBody}
                        onChange={(e) => setEditBody(e.target.value)}
                        rows={3}
                        aria-label="Edit comment"
                      />
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditingId(null)
                            setEditBody('')
                          }}
                          disabled={savingEdit}
                        >
                          Cancel
                        </Button>
                        <Button size="sm" onClick={() => void saveEdit(c._id)} disabled={savingEdit}>
                          {savingEdit ? 'Saving…' : 'Save'}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-1 whitespace-pre-wrap text-sm text-decoricks-dark">{c.body}</p>
                  )}
                  {!showEditBox && (canEdit || canDelete) && !c.isDeleted && (
                    <div className="mt-1.5 flex justify-end gap-1">
                      {canEdit && (
                        <Button variant="ghost" size="sm" onClick={() => startEdit(c)}>
                          Edit
                        </Button>
                      )}
                      {canDelete && (
                        <Button variant="ghost" size="sm" onClick={() => void remove(c._id)}>
                          Delete
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              )
            })
          )}
        </ul>

        <div className="mt-3 flex flex-col gap-2">
          <Textarea
            value={composer}
            onChange={(e) => setComposer(e.target.value)}
            placeholder="Write a comment…"
            rows={3}
            aria-label="New comment"
            disabled={posting}
          />
          <div className="flex items-center justify-between">
            <p className="text-xs text-ink-muted">
              Editable for {editWindowMinutes} min after posting.
            </p>
            <Button size="sm" onClick={() => void post()} disabled={posting || composer.trim().length === 0}>
              {posting ? 'Posting…' : 'Comment'}
            </Button>
          </div>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-decoricks-dark">Activity</h3>
        {activity.length === 0 ? (
          <p className="text-xs text-ink-muted">Nothing logged yet.</p>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {activity.map((a) => (
              <li key={a._id} className="flex items-baseline gap-2 text-xs text-ink-secondary">
                <Badge size="sm" variant="default">
                  {ACTION_LABELS[a.kind] ?? a.kind}
                </Badge>
                <span className="text-ink-muted">
                  by {currentUserId === a.actorId ? 'you' : `User ${shortId(a.actorId)}`}
                </span>
                <span className="ml-auto tabular-nums text-ink-muted" title={a.at}>
                  {relTime(a.at, now)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}

