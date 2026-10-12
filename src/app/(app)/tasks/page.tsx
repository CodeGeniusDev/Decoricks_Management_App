'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PageTransition } from '@/components/PageTransition'
import { PageHeader } from '@/components/layout/Page'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Select } from '@/components/ui/Select'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { Toast } from '@/components/ui/Toast'
import { IconPlus } from '@/components/ui/icons'
import { apiFetch } from '@/lib/api-client'
import { useAuth } from '@/components/auth/AuthProvider'
import { isFounder } from '@/lib/permissions-client'

/**
 * Phase 6 board.
 *
 * This first cut ships the read path (columns + cards), create/edit modal,
 * explicit "Move to…" dropdown and Founder-only column add. Drag-and-drop,
 * keyboard sensor and the polling/focus refresh arrive in Phase 6d and reuse
 * the same endpoints.
 *
 * Everything is optimistic where it can be: a version mismatch on PATCH or
 * move is surfaced as a toast plus a refetch of the board rather than a
 * silent overwrite, per SPEC §6.6.
 */

type Priority = 'low' | 'medium' | 'high' | 'urgent'

interface ColumnDto {
  _id: string
  name: string
  isDoneColumn: boolean
  position: number
}

interface TaskDto {
  _id: string
  taskNumber?: string
  boardId: string
  columnId: string
  position: number
  title: string
  description?: string
  assigneeIds: string[]
  assigneeName?: string
  priority: Priority
  dueDate?: string | null
  labelIds: string[]
  checklist: { text: string; isDone: boolean }[]
  completedAt?: string | null
  version: number
  isArchived: boolean
}

interface BoardSummary {
  _id: string
  name: string
  description?: string
  taskCount: number
}

interface BoardDetail {
  board: BoardSummary
  columns: ColumnDto[]
  tasksByColumn: Record<string, TaskDto[]>
}

const PRIORITY_LABEL: Record<Priority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
}

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
]

/** Simple hex palette for a card's priority edge. Brand-safe neutrals. */
const priorityAccent: Record<Priority, string> = {
  low: 'border-l-4 border-l-slate-300',
  medium: 'border-l-4 border-l-blue-300',
  high: 'border-l-4 border-l-amber-400',
  urgent: 'border-l-4 border-l-rose-500',
}

const emptyDraft = () => ({
  title: '',
  description: '',
  priority: 'medium' as Priority,
  dueDate: '',
})

export default function TasksBoardPage() {
  const { user } = useAuth()
  const founder = isFounder(user?.role)

  const [boards, setBoards] = useState<BoardSummary[]>([])
  const [boardId, setBoardId] = useState<string | null>(null)
  const [detail, setDetail] = useState<BoardDetail | null>(null)
  const [loadingBoards, setLoadingBoards] = useState(true)
  const [loadingBoard, setLoadingBoard] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ kind: 'success' | 'error' | 'info'; message: string } | null>(null)

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<TaskDto | null>(null)
  const [creatingInColumn, setCreatingInColumn] = useState<ColumnDto | null>(null)
  const [draft, setDraft] = useState(emptyDraft())
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)

  const [columnModalOpen, setColumnModalOpen] = useState(false)
  const [newColumnName, setNewColumnName] = useState('')

  const showToast = (kind: 'success' | 'error' | 'info', message: string) => {
    setToast({ kind, message })
    window.setTimeout(() => setToast(null), 3500)
  }

  const loadBoards = useCallback(async () => {
    setLoadingBoards(true)
    try {
      const res = await apiFetch('/api/boards')
      const body = await res.json()
      if (!res.ok || !body.success) throw new Error(body?.error?.message ?? 'Failed to load boards')
      const list: BoardSummary[] = body.data.boards ?? []
      setBoards(list)
      setBoardId((prev) => prev ?? list[0]?._id ?? null)
      if (list.length === 0) setError('No boards yet. Ask the Founder to create one.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load boards')
    } finally {
      setLoadingBoards(false)
    }
  }, [])

  const loadBoard = useCallback(async (id: string) => {
    setLoadingBoard(true)
    try {
      const res = await apiFetch(`/api/boards/${id}`)
      const body = await res.json()
      if (!res.ok || !body.success) throw new Error(body?.error?.message ?? 'Failed to load board')
      setDetail(body.data as BoardDetail)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load board')
    } finally {
      setLoadingBoard(false)
    }
  }, [])

  useEffect(() => {
    loadBoards()
  }, [loadBoards])

  useEffect(() => {
    if (boardId) loadBoard(boardId)
  }, [boardId, loadBoard])

  const openCreate = (column: ColumnDto) => {
    setEditing(null)
    setCreatingInColumn(column)
    setDraft(emptyDraft())
    setFormErrors({})
    setModalOpen(true)
  }

  const openEdit = (task: TaskDto) => {
    setEditing(task)
    setCreatingInColumn(null)
    setDraft({
      title: task.title,
      description: task.description ?? '',
      priority: task.priority,
      dueDate: task.dueDate ? task.dueDate.slice(0, 10) : '',
    })
    setFormErrors({})
    setModalOpen(true)
  }

  const submitTask = async () => {
    if (submittingRef.current) return
    const errs: Record<string, string> = {}
    if (!draft.title.trim()) errs.title = 'Title is required'
    if (Object.keys(errs).length > 0) {
      setFormErrors(errs)
      return
    }
    submittingRef.current = true
    setSubmitting(true)
    try {
      if (editing && boardId) {
        const body: Record<string, unknown> = {
          title: draft.title.trim(),
          description: draft.description.trim() || undefined,
          priority: draft.priority,
          dueDate: draft.dueDate || null,
          version: editing.version,
        }
        const res = await apiFetch(`/api/tasks/${editing._id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        })
        const json = await res.json()
        if (res.status === 409) {
          showToast('error', json?.error?.message ?? 'Someone moved this card. Refreshed.')
          await loadBoard(boardId)
          setModalOpen(false)
          return
        }
        if (!res.ok || !json.success) throw new Error(json?.error?.message ?? 'Update failed')
        showToast('success', 'Task updated')
      } else if (creatingInColumn && boardId) {
        const body = {
          boardId,
          columnId: creatingInColumn._id,
          title: draft.title.trim(),
          description: draft.description.trim() || undefined,
          priority: draft.priority,
          dueDate: draft.dueDate || undefined,
          assigneeIds: [],
          labelIds: [],
          checklist: [],
          idempotencyKey: `t-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        }
        const res = await apiFetch('/api/tasks', { method: 'POST', body: JSON.stringify(body) })
        const json = await res.json()
        if (!res.ok || !json.success) throw new Error(json?.error?.message ?? 'Create failed')
        showToast('success', 'Task created')
      }
      setModalOpen(false)
      if (boardId) await loadBoard(boardId)
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const moveTask = async (task: TaskDto, toColumnId: string) => {
    if (toColumnId === task.columnId) return
    try {
      const res = await apiFetch(`/api/tasks/${task._id}/move`, {
        method: 'POST',
        body: JSON.stringify({ toColumnId, version: task.version }),
      })
      const json = await res.json()
      if (res.status === 409) {
        showToast('error', json?.error?.message ?? 'Someone moved this card. Refreshed.')
        if (boardId) await loadBoard(boardId)
        return
      }
      if (!res.ok || !json.success) throw new Error(json?.error?.message ?? 'Move failed')
      showToast('success', 'Moved')
      if (boardId) await loadBoard(boardId)
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Move failed')
    }
  }

  const archiveTask = async (task: TaskDto) => {
    if (!window.confirm(`Archive "${task.title}"? It will disappear from the board but stay in history.`)) return
    try {
      const res = await apiFetch(`/api/tasks/${task._id}`, { method: 'DELETE' })
      const json = await res.json()
      if (res.status === 409) {
        showToast('error', 'Someone edited this card. Refreshed.')
        if (boardId) await loadBoard(boardId)
        return
      }
      if (!res.ok || !json.success) throw new Error(json?.error?.message ?? 'Archive failed')
      showToast('success', 'Archived')
      if (boardId) await loadBoard(boardId)
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Archive failed')
    }
  }

  const createColumn = async () => {
    if (!boardId) return
    const name = newColumnName.trim()
    if (!name) {
      showToast('error', 'Column name is required')
      return
    }
    try {
      const res = await apiFetch(`/api/boards/${boardId}/columns`, {
        method: 'POST',
        body: JSON.stringify({ boardId, name, isDoneColumn: false }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json?.error?.message ?? 'Add column failed')
      setColumnModalOpen(false)
      setNewColumnName('')
      showToast('success', 'Column added')
      await loadBoard(boardId)
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Add column failed')
    }
  }

  const boardOptions = useMemo(
    () => boards.map((b) => ({ value: b._id, label: `${b.name} (${b.taskCount})` })),
    [boards]
  )

  const renderCard = (task: TaskDto, columns: ColumnDto[]) => (
    <div
      key={task._id}
      className={`group rounded-lg border border-line-subtle bg-surface-raised p-3 shadow-sm transition-shadow hover:shadow ${priorityAccent[task.priority]}`}
    >
      <button
        type="button"
        className="block w-full text-left"
        onClick={() => openEdit(task)}
      >
        <p className="text-sm font-medium text-decoricks-dark">{task.title}</p>
        {task.taskNumber && (
          <p className="mt-0.5 text-xs text-ink-muted tabular-nums">{task.taskNumber}</p>
        )}
      </button>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge size="sm" variant={task.priority === 'urgent' ? 'error' : task.priority === 'high' ? 'warning' : 'default'}>
          {PRIORITY_LABEL[task.priority]}
        </Badge>
        {task.dueDate && (
          <span className="text-xs text-ink-muted tabular-nums">{task.dueDate.slice(0, 10)}</span>
        )}
        {task.checklist?.length > 0 && (
          <span className="text-xs text-ink-muted">
            {task.checklist.filter((c) => c.isDone).length}/{task.checklist.length}
          </span>
        )}
      </div>
      <div className="mt-2 flex items-center justify-end gap-1">
        <Select
          value={task.columnId}
          onChange={(e) => moveTask(task, e.target.value)}
          options={columns.map((c) => ({ value: c._id, label: `Move to ${c.name}` }))}
          aria-label="Move task to another column"
        />
        {founder && (
          <Button variant="ghost" size="sm" onClick={() => archiveTask(task)} aria-label="Archive task">
            Archive
          </Button>
        )}
      </div>
    </div>
  )

  return (
    <PageTransition>
      <PageHeader
        title="Task board"
        description="Team board — cards, columns and owners. Dragging and comments arrive in the next phase."
        actions={
          founder && boardId ? (
            <Button variant="secondary" size="sm" onClick={() => setColumnModalOpen(true)}>
              <IconPlus size={16} className="mr-1" /> Add column
            </Button>
          ) : null
        }
      />

      {error && (
        <div className="mb-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}

      {loadingBoards ? (
        <Skeleton className="h-6 w-48" />
      ) : boards.length > 0 ? (
        <div className="mb-4 flex items-center gap-3">
          <span className="text-sm text-ink-muted">Board</span>
          <Select
            value={boardId ?? ''}
            onChange={(e) => setBoardId(e.target.value)}
            options={boardOptions}
            aria-label="Select board"
            className="max-w-xs"
          />
        </div>
      ) : null}

      {loadingBoard || !detail ? (
        <div className="grid gap-3 md:grid-cols-4">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      ) : detail.columns.length === 0 ? (
        <EmptyState
          title="No columns"
          description="The Founder can add the first column to this board."
        />
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {detail.columns.map((col) => {
            const tasks = detail.tasksByColumn[col._id] ?? []
            return (
              <section
                key={col._id}
                className="flex w-72 shrink-0 flex-col rounded-lg border border-line-subtle bg-surface-sunken"
              >
                <header className="flex items-center justify-between border-b border-line-subtle px-3 py-2">
                  <div>
                    <h3 className="text-sm font-semibold text-decoricks-dark">{col.name}</h3>
                    <p className="text-xs text-ink-muted">
                      {tasks.length} card{tasks.length === 1 ? '' : 's'}
                      {col.isDoneColumn && ' · done column'}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => openCreate(col)} aria-label="Add card">
                    <IconPlus size={16} />
                  </Button>
                </header>
                <div className="flex flex-col gap-2 p-2">
                  {tasks.length === 0 ? (
                    <p className="px-1 py-3 text-center text-xs text-ink-muted">Empty</p>
                  ) : (
                    tasks.map((t) => renderCard(t, detail.columns))
                  )}
                </div>
              </section>
            )
          })}
        </div>
      )}

      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? 'Edit task' : 'New task'}
        description={
          editing
            ? `Version ${editing.version} — saving will bump it. A conflicting edit shows a 409 and reloads the board.`
            : creatingInColumn
              ? `Into "${creatingInColumn.name}"`
              : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitTask} disabled={submitting}>
              {submitting ? 'Saving…' : editing ? 'Save changes' : 'Create task'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Input
            label="Title"
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            error={formErrors.title}
          />
          <Textarea
            label="Description"
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            rows={4}
          />
          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Priority"
              value={draft.priority}
              onChange={(e) => setDraft({ ...draft, priority: e.target.value as Priority })}
              options={PRIORITY_OPTIONS}
            />
            <Input
              label="Due date"
              type="date"
              value={draft.dueDate}
              onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
            />
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={columnModalOpen}
        onClose={() => setColumnModalOpen(false)}
        title="Add column"
        description="Only the Founder can add or archive columns. The board's done column controls completedAt on its cards."
        footer={
          <>
            <Button variant="ghost" onClick={() => setColumnModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={createColumn}>Add column</Button>
          </>
        }
      >
        <Input
          label="Column name"
          value={newColumnName}
          onChange={(e) => setNewColumnName(e.target.value)}
          placeholder="e.g. Waiting on supplier"
        />
      </Modal>

      {toast && <Toast type={toast.kind} message={toast.message} onClose={() => setToast(null)} />}
    </PageTransition>
  )
}
