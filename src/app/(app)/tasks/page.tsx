'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
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
import { Tabs } from '@/components/ui/Tabs'
import { IconPlus } from '@/components/ui/icons'
import { apiFetch } from '@/lib/api-client'
import { useAuth } from '@/components/auth/AuthProvider'
import { isFounder } from '@/lib/permissions-client'
import { usePolling } from '@/hooks/usePolling'
import {
  TaskDetailPanel,
  type ActivityDto,
  type CommentDto,
} from '@/components/tasks/TaskDetailPanel'
import { TaskListView } from '@/components/tasks/TaskListView'

/**
 * Phase 6 board.
 *
 * 6c shipped read path + create/edit + explicit "Move to…" dropdown.
 * 6d adds:
 *   - dnd-kit drag-and-drop between columns (PointerSensor with a 4px
 *     activation distance so a click on the card body still opens the edit
 *     modal, plus a KeyboardSensor for accessibility — Tab to the card's
 *     drag handle, Space to lift, arrows to move, Space to drop, Escape to
 *     cancel).
 *   - Optimistic cross-column move with 409 rollback. On any conflict or
 *     network error we reload the board so the card returns to its server
 *     position with a fresh version token.
 *   - Focus / visibility / online refresh through `usePolling`. Pauses while
 *     a modal is open or a drag is in flight so an idle refresh cannot steal
 *     the user's cursor or re-sort cards mid-gesture.
 *
 * The "Move to…" dropdown stays as the primary fallback for anyone who
 * prefers clicking over dragging, and both paths hit the same
 * POST /api/tasks/[id]/move endpoint with the same version guard.
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

/** Droppable ids are namespaced so we can tell a column drop from a card drop. */
const columnDropId = (columnId: string) => `col:${columnId}`

export default function TasksBoardPage() {
  const { user } = useAuth()
  const founder = isFounder(user?.role)

  const [boards, setBoards] = useState<BoardSummary[]>([])
  const [boardId, setBoardId] = useState<string | null>(null)
  const [detail, setDetail] = useState<BoardDetail | null>(null)
  const [loadingBoards, setLoadingBoards] = useState(true)
  const [loadingBoard, setLoadingBoard] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<{
    kind: 'success' | 'error' | 'info' | 'warning'
    message: string
  } | null>(null)

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<TaskDto | null>(null)
  const [creatingInColumn, setCreatingInColumn] = useState<ColumnDto | null>(null)
  const [draft, setDraft] = useState(emptyDraft())
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)

  // Phase 6e: comments + activity, loaded lazily the first time a card is
  // opened for editing. Creating a new task never touches the discussion tab
  // because there is no task id yet — the panel is not mounted then.
  const [detailComments, setDetailComments] = useState<CommentDto[]>([])
  const [detailActivity, setDetailActivity] = useState<ActivityDto[]>([])
  const [editWindowMinutes, setEditWindowMinutes] = useState<number>(15)
  const [detailLoading, setDetailLoading] = useState(false)

  const [columnModalOpen, setColumnModalOpen] = useState(false)
  const [newColumnName, setNewColumnName] = useState('')

  // Phase 6f: views + filters. `board` is the dnd-kit pipeline; `mine` and
  // `overdue` are flat filtered sets fetched from /api/tasks. The filter bar
  // only applies to the flat views — the board shows everything in its columns.
  const [view, setView] = useState<'board' | 'mine' | 'overdue'>('board')
  const [filterPriority, setFilterPriority] = useState<'' | Priority>('')
  const [filterLabelId, setFilterLabelId] = useState('')
  const [filterAssigneeId, setFilterAssigneeId] = useState('')
  const [filterSearch, setFilterSearch] = useState('')
  const [listTasks, setListTasks] = useState<TaskDto[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [labels, setLabels] = useState<{ _id: string; name: string }[]>([])
  const [users, setUsers] = useState<{ _id: string; name: string }[]>([])

  // Drag state — the id of the card currently being dragged, or null. Also
  // used to render the dashed placeholder inside the source column so the
  // user can see where the card will return if they drop outside any target.
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const activeTaskRef = useRef<TaskDto | null>(null)

  const showToast = (
    kind: 'success' | 'error' | 'info' | 'warning',
    message: string
  ) => setToast({ kind, message })

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

  // Labels are visible to anyone with tasks.view. The users list needs
  // users.view, which a Partner does not have — so we try and silently drop
  // it on failure; the assignee filter simply renders empty for them (they
  // still get the "Me" pseudo-option via the My-tasks view).
  const loadOptions = useCallback(async () => {
    try {
      const res = await apiFetch('/api/task-labels')
      const body = await res.json()
      if (res.ok && body.success) setLabels(body.data.labels ?? [])
    } catch {
      /* labels are a nicety; the board works without them */
    }
    try {
      const res = await apiFetch('/api/users')
      const body = await res.json()
      if (res.ok && body.success) {
        setUsers(
          (body.data.users ?? [])
            .filter((u: { isActive?: boolean }) => u.isActive !== false)
            .map((u: { _id: string; name: string }) => ({ _id: u._id, name: u.name }))
        )
      }
    } catch {
      /* no users.view — assignee filter stays empty */
    }
  }, [])

  /**
   * Fetch the flat list for the My-tasks / Overdue views. The filters map
   * straight onto /api/tasks query params so the list, the board and any
   * future CSV export agree on what "overdue" and "mine" mean.
   */
  const loadList = useCallback(async () => {
    setListLoading(true)
    try {
      const params = new URLSearchParams()
      if (view === 'mine') params.set('assignee', 'me')
      if (view === 'overdue') params.set('overdue', 'true')
      if (filterPriority) params.set('priority', filterPriority)
      if (filterLabelId) params.set('labelId', filterLabelId)
      if (filterAssigneeId) params.set('assigneeId', filterAssigneeId)
      if (filterSearch.trim()) params.set('search', filterSearch.trim())
      params.set('limit', '200')
      const res = await apiFetch(`/api/tasks?${params.toString()}`)
      const body = await res.json()
      if (!res.ok || !body.success) throw new Error(body?.error?.message ?? 'Failed to load tasks')
      setListTasks((body.data.tasks ?? []) as TaskDto[])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tasks')
      setListTasks([])
    } finally {
      setListLoading(false)
    }
  }, [view, filterPriority, filterLabelId, filterAssigneeId, filterSearch])

  /** Reload whatever the active view shows after a save, so a card edited from
   *  the My-tasks list updates the list, not an invisible board. */
  const refreshCurrentView = useCallback(async () => {
    if (view === 'board') {
      if (boardId) await loadBoard(boardId)
    } else {
      await loadList()
    }
  }, [view, boardId, loadBoard, loadList])

  useEffect(() => {
    loadBoards()
    loadOptions()
  }, [loadBoards, loadOptions])

  useEffect(() => {
    if (boardId) loadBoard(boardId)
  }, [boardId, loadBoard])

  // Fetch the flat list whenever the view or a filter changes. Debounced by
  // the search box's own onChange cadence; a short timer keeps keystrokes
  // from firing a request each one.
  useEffect(() => {
    if (view === 'board') return
    const t = setTimeout(() => void loadList(), 250)
    return () => clearTimeout(t)
  }, [view, loadList])

  // Refresh the board when the tab regains focus, becomes visible again, or
  // the network comes back — but never while a modal is open or a drag is in
  // progress. That's what preserves "open drawer + in-flight drag" state.
  usePolling(
    () =>
      view === 'board'
        ? boardId
          ? loadBoard(boardId)
          : Promise.resolve()
        : loadList(),
    { paused: modalOpen || columnModalOpen || activeTaskId !== null }
  )

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
    // Fetch the discussion + timeline for this card. Not awaited — the
    // Details tab opens immediately, Discussion fills in when the round-trip
    // lands. Any previous card's data is cleared so we never show stale rows.
    setDetailComments([])
    setDetailActivity([])
    setDetailLoading(true)
    void (async () => {
      try {
        const res = await apiFetch(`/api/tasks/${task._id}`)
        const body = await res.json()
        if (!res.ok || !body.success) throw new Error(body?.error?.message ?? 'Load failed')
        setDetailComments((body.data.comments ?? []) as CommentDto[])
        setDetailActivity((body.data.activity ?? []) as ActivityDto[])
        if (typeof body.data.editWindowMinutes === 'number') {
          setEditWindowMinutes(body.data.editWindowMinutes)
        }
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : 'Could not load discussion')
      } finally {
        setDetailLoading(false)
      }
    })()
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
      await refreshCurrentView()
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  /**
   * Move a task. Called by both the "Move to…" dropdown and the drag layer.
   *
   * Optimistic: we mutate the local `detail` first so the card is already in
   * place when the request round-trips. On any error — including 409 — we
   * reload the whole board rather than trying to undo the mutation, because
   * a 409 means our version token is stale and the correct card is now
   * whatever the server says, not what we last rendered.
   */
  const moveTask = useCallback(
    async (task: TaskDto, toColumnId: string, afterTaskId: string | null = null) => {
      if (!boardId) return
      if (toColumnId === task.columnId && afterTaskId === null) return
      if (toColumnId === task.columnId && afterTaskId === task._id) return

      // Snapshot so we can restore on network failure before falling back to
      // a full reload — this keeps the optimistic UI honest.
      const previous = detail
      const moved: TaskDto = { ...task, columnId: toColumnId }
      setDetail((current) => {
        if (!current) return current
        const fromList = (current.tasksByColumn[task.columnId] ?? []).filter((t) => t._id !== task._id)
        const toList = [...(current.tasksByColumn[toColumnId] ?? [])]
        // Filter out the task if it was already in the destination column
        // (in-column reorder case) before inserting at the target index.
        const filtered = toList.filter((t) => t._id !== task._id)
        if (afterTaskId) {
          const idx = filtered.findIndex((t) => t._id === afterTaskId)
          if (idx >= 0) {
            filtered.splice(idx + 1, 0, moved)
          } else {
            filtered.push(moved)
          }
        } else {
          filtered.unshift(moved)
        }
        return {
          ...current,
          tasksByColumn: {
            ...current.tasksByColumn,
            [task.columnId]: fromList,
            [toColumnId]: filtered,
          },
        }
      })

      try {
        const res = await apiFetch(`/api/tasks/${task._id}/move`, {
          method: 'POST',
          body: JSON.stringify({
            toColumnId,
            afterTaskId,
            version: task.version,
          }),
        })
        const json = await res.json()
        if (res.status === 409) {
          showToast('warning', json?.error?.message ?? 'Someone moved this card. Board refreshed.')
          await loadBoard(boardId)
          return
        }
        if (!res.ok || !json.success) throw new Error(json?.error?.message ?? 'Move failed')
        showToast('success', 'Moved')
        // Server is source of truth for `position` and bumped `version`.
        // Reload quietly so the next edit/move starts from the fresh token.
        await loadBoard(boardId)
      } catch (err) {
        if (previous) setDetail(previous)
        showToast('error', err instanceof Error ? err.message : 'Move failed')
      }
    },
    [boardId, detail, loadBoard]
  )

  const archiveTask = async (task: TaskDto) => {
    if (!boardId) return
    if (!window.confirm(`Archive "${task.title}"? It will disappear from the board but stay in history.`))
      return
    try {
      const res = await apiFetch(`/api/tasks/${task._id}`, { method: 'DELETE' })
      const json = await res.json()
      if (res.status === 409) {
        showToast('error', 'Someone edited this card. Refreshed.')
        await loadBoard(boardId)
        return
      }
      if (!res.ok || !json.success) throw new Error(json?.error?.message ?? 'Archive failed')
      showToast('success', 'Archived')
      await loadBoard(boardId)
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

  // DnD sensors. PointerSensor with a 4px activation distance means a plain
  // click (no movement) still fires onClick on the card body and opens the
  // edit modal — the drag only starts once the pointer actually moves.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor)
  )

  const findTask = useCallback(
    (taskId: string): { task: TaskDto; columnId: string; index: number } | null => {
      if (!detail) return null
      for (const col of detail.columns) {
        const list = detail.tasksByColumn[col._id] ?? []
        const index = list.findIndex((t) => t._id === taskId)
        if (index >= 0) return { task: list[index], columnId: col._id, index }
      }
      return null
    },
    [detail]
  )

  const handleDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id)
    setActiveTaskId(id)
    const found = findTask(id)
    activeTaskRef.current = found?.task ?? null
  }

  const handleDragOver = (_event: DragOverEvent) => {
    // We intentionally do not mutate the list mid-drag. The placeholder
    // highlight inside ColumnDropZone is enough feedback, and mutating the
    // list mid-flight would fight with dnd-kit's own transform calculation.
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const dragged = activeTaskRef.current
    setActiveTaskId(null)
    activeTaskRef.current = null
    if (!dragged || !event.over) return

    const overId = String(event.over.id)
    let toColumnId: string | null = null
    let afterTaskId: string | null = null

    if (overId.startsWith('col:')) {
      toColumnId = overId.slice('col:'.length)
      // Drop on empty column body → append at end.
      const list = detail?.tasksByColumn[toColumnId] ?? []
      afterTaskId = list.length > 0 ? list[list.length - 1]._id : null
    } else {
      // Dropped on a specific card — insert after it in that card's column.
      const found = findTask(overId)
      if (!found) return
      toColumnId = found.columnId
      afterTaskId = found.task._id
    }

    if (!toColumnId) return
    if (toColumnId === dragged.columnId && afterTaskId === dragged._id) return
    void moveTask(dragged, toColumnId, afterTaskId)
  }

  const handleDragCancel = () => {
    setActiveTaskId(null)
    activeTaskRef.current = null
  }

  return (
    <PageTransition>
      <PageHeader
        title="Task board"
        description="Team board — drag cards between columns, or use the Move-to dropdown. Keyboard: Tab to a card handle, press Space to lift, arrows to move, Space to drop."
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

      {/* View switcher — board pipeline vs the two filtered flat views. */}
      <div className="mb-4 inline-flex rounded-lg border border-line-subtle bg-surface-sunken p-0.5">
        {(
          [
            { id: 'board', label: 'Board' },
            { id: 'mine', label: 'My tasks' },
            { id: 'overdue', label: 'Overdue' },
          ] as const
        ).map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => setView(v.id)}
            aria-pressed={view === v.id}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              view === v.id
                ? 'bg-surface-raised text-decoricks-dark shadow-sm'
                : 'text-ink-muted hover:text-decoricks-dark'
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      {/* Board selector: only meaningful in the pipeline view. */}
      {view === 'board' &&
        (loadingBoards ? (
          <Skeleton className="mb-4 h-6 w-48" />
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
        ) : null)}

      {/* Filter bar: only the flat views consume it. */}
      {view !== 'board' && (
        <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
          <Input
            placeholder="Search title or #…"
            value={filterSearch}
            onChange={(e) => setFilterSearch(e.target.value)}
            aria-label="Search tasks"
          />
          <Select
            value={filterPriority}
            onChange={(e) => setFilterPriority(e.target.value as '' | Priority)}
            options={[{ value: '', label: 'All priorities' }, ...PRIORITY_OPTIONS]}
            aria-label="Filter by priority"
          />
          <Select
            value={filterLabelId}
            onChange={(e) => setFilterLabelId(e.target.value)}
            options={[{ value: '', label: 'All labels' }, ...labels.map((l) => ({ value: l._id, label: l.name }))]}
            aria-label="Filter by label"
          />
          <Select
            value={filterAssigneeId}
            onChange={(e) => setFilterAssigneeId(e.target.value)}
            options={[{ value: '', label: 'All members' }, ...users.map((u) => ({ value: u._id, label: u.name }))]}
            aria-label="Filter by assignee"
            disabled={users.length === 0}
          />
        </div>
      )}

      {view === 'board' ? (
        loadingBoard || !detail ? (
          <div className="grid gap-3 md:grid-cols-4">
            <Skeleton className="h-64" />
            <Skeleton className="h-64" />
            <Skeleton className="h-64" />
            <Skeleton className="h-64" />
          </div>
        ) : detail.columns.length === 0 ? (
          <EmptyState title="No columns" description="The Founder can add the first column to this board." />
        ) : (
          <DndContext
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <div className="flex gap-3 overflow-x-auto pb-2">
              {detail.columns.map((col) => (
                <ColumnList
                  key={col._id}
                  column={col}
                  tasks={detail.tasksByColumn[col._id] ?? []}
                  columns={detail.columns}
                  activeTaskId={activeTaskId}
                  canArchive={founder}
                  onEdit={openEdit}
                  onAdd={() => openCreate(col)}
                  onMove={(task, toColumnId) => moveTask(task, toColumnId, null)}
                  onArchive={archiveTask}
                />
              ))}
            </div>
            {/* Rendered once at the board level so the dragged card floats above
                every column. dnd-kit measures it as the drag overlay. */}
            <BoardDragOverlay
              task={
                activeTaskId
                  ? detail.tasksByColumn[
                      findTask(activeTaskId)?.columnId ?? ''
                    ]?.find((t) => t._id === activeTaskId) ?? null
                  : null
              }
            />
          </DndContext>
        )
      ) : (
        <TaskListView
          tasks={listTasks}
          loading={listLoading}
          userNames={new Map(users.map((u) => [u._id, u.name]))}
          labelNames={new Map(labels.map((l) => [l._id, l.name]))}
          emptyTitle={view === 'mine' ? 'Nothing assigned to you' : 'Nothing is overdue'}
          emptyDescription={
            view === 'mine'
              ? 'No open cards list you as an assignee for the current filters.'
              : 'No cards are past their due date outside a done column right now.'
          }
          onOpen={(t) => {
            const full = listTasks.find((x) => x._id === t._id)
            if (full) openEdit(full)
          }}
        />
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
        size={editing ? 'lg' : 'md'}
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
        {editing ? (
          <Tabs
            tabs={[
              { id: 'details', label: 'Details' },
              { id: 'discussion', label: `Discussion${detailComments.length ? ` (${detailComments.length})` : ''}` },
            ]}
          >
            {(tab) =>
              tab === 'details' ? (
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
                  {detailLoading && (
                    <p className="text-xs text-ink-muted">Loading discussion…</p>
                  )}
                </div>
              ) : (
                <TaskDetailPanel
                  taskId={editing._id}
                  comments={detailComments}
                  activity={detailActivity}
                  editWindowMinutes={editWindowMinutes}
                  currentUserId={user?._id}
                  canModerate={founder}
                  onCommentsChange={setDetailComments}
                  onNotice={showToast}
                />
              )
            }
          </Tabs>
        ) : (
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
        )}
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

      {toast && (
        <div className="fixed top-20 right-4 z-50 max-w-[90vw]">
          <Toast message={toast.message} type={toast.kind} onClose={() => setToast(null)} />
        </div>
      )}
    </PageTransition>
  )
}

/* -------------------------------------------------------------------------- */
/* Column + card components — split out so they can each own a dnd-kit hook.  */
/* -------------------------------------------------------------------------- */

interface ColumnListProps {
  column: ColumnDto
  tasks: TaskDto[]
  columns: ColumnDto[]
  activeTaskId: string | null
  canArchive: boolean
  onEdit: (task: TaskDto) => void
  onAdd: () => void
  onMove: (task: TaskDto, toColumnId: string) => void
  onArchive: (task: TaskDto) => void
}

function ColumnList(props: ColumnListProps) {
  const { column, tasks, columns, activeTaskId, canArchive } = props
  const { setNodeRef, isOver } = useDroppable({
    id: columnDropId(column._id),
    data: { columnId: column._id },
  })

  return (
    <section
      className={`flex w-72 shrink-0 flex-col rounded-lg border bg-surface-sunken transition-colors ${
        isOver ? 'border-decoricks-brown' : 'border-line-subtle'
      }`}
    >
      <header className="flex items-center justify-between border-b border-line-subtle px-3 py-2">
        <div>
          <h3 className="text-sm font-semibold text-decoricks-dark">{column.name}</h3>
          <p className="text-xs text-ink-muted">
            {tasks.length} card{tasks.length === 1 ? '' : 's'}
            {column.isDoneColumn && ' · done column'}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={props.onAdd} aria-label="Add card">
          <IconPlus size={16} />
        </Button>
      </header>
      <div ref={setNodeRef} className="flex min-h-[8rem] flex-col gap-2 p-2">
        {tasks.length === 0 ? (
          <p
            className={`px-1 py-3 text-center text-xs ${
              isOver ? 'text-decoricks-brown' : 'text-ink-muted'
            }`}
          >
            {isOver ? 'Drop here' : 'Empty'}
          </p>
        ) : (
          tasks.map((t) => (
            <TaskCard
              key={t._id}
              task={t}
              columns={columns}
              isDragging={activeTaskId === t._id}
              onEdit={props.onEdit}
              onMove={props.onMove}
              canArchive={canArchive}
              onArchive={props.onArchive}
            />
          ))
        )}
      </div>
    </section>
  )
}

interface TaskCardProps {
  task: TaskDto
  columns: ColumnDto[]
  isDragging: boolean
  onEdit: (task: TaskDto) => void
  onMove: (task: TaskDto, toColumnId: string) => void
  canArchive: boolean
  onArchive: (task: TaskDto) => void
}

function TaskCard(props: TaskCardProps) {
  const { task, columns, isDragging, canArchive } = props
  const { attributes, listeners, setNodeRef, setActivatorNodeRef } = useDraggable({
    id: task._id,
    data: { task },
  })

  // The card body is clickable (opens edit modal). Only the small grip
  // button on the left is the drag activator — that way the Select and
  // Archive button inside the card keep working normally.
  return (
    <div
      ref={setNodeRef}
      className={`group rounded-lg border border-line-subtle bg-surface-raised p-3 shadow-sm transition-shadow hover:shadow ${
        priorityAccent[task.priority]
      } ${isDragging ? 'opacity-40' : ''}`}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Drag ${task.title} to another column`}
          className="mt-0.5 flex h-6 w-4 shrink-0 cursor-grab items-center justify-center rounded text-ink-muted hover:bg-surface-sunken hover:text-decoricks-dark focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-decoricks-brown active:cursor-grabbing"
        >
          <DragGrip />
        </button>
        <button
          type="button"
          className="block flex-1 text-left"
          onClick={() => props.onEdit(task)}
        >
          <p className="text-sm font-medium text-decoricks-dark">{task.title}</p>
          {task.taskNumber && (
            <p className="mt-0.5 text-xs text-ink-muted tabular-nums">{task.taskNumber}</p>
          )}
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge
          size="sm"
          variant={
            task.priority === 'urgent'
              ? 'error'
              : task.priority === 'high'
                ? 'warning'
                : 'default'
          }
        >
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
          onChange={(e) => props.onMove(task, e.target.value)}
          options={columns.map((c) => ({ value: c._id, label: `Move to ${c.name}` }))}
          aria-label="Move task to another column"
        />
        {canArchive && (
          <Button variant="ghost" size="sm" onClick={() => props.onArchive(task)} aria-label="Archive task">
            Archive
          </Button>
        )}
      </div>
    </div>
  )
}

function BoardDragOverlay({ task }: { task: TaskDto | null }) {
  // Using DndContext.Overlay-style rendering: we translate the dragged card
  // with a slight tilt so it visually lifts off the board. dnd-kit does not
  // provide a built-in overlay component, so we render a fixed card that
  // mirrors the source while the drag is active.
  if (!task) return null
  return (
    <div
      className={`pointer-events-none fixed left-0 top-0 z-50 w-64 rounded-lg border border-line-subtle bg-surface-raised p-3 shadow-lg ${priorityAccent[task.priority]}`}
      style={{ transform: 'rotate(2deg)' }}
      aria-hidden="true"
    >
      <p className="text-sm font-medium text-decoricks-dark">{task.title}</p>
      {task.taskNumber && <p className="mt-0.5 text-xs text-ink-muted tabular-nums">{task.taskNumber}</p>}
    </div>
  )
}

function DragGrip() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
      <circle cx="2" cy="2" r="1.4" />
      <circle cx="8" cy="2" r="1.4" />
      <circle cx="2" cy="7" r="1.4" />
      <circle cx="8" cy="7" r="1.4" />
      <circle cx="2" cy="12" r="1.4" />
      <circle cx="8" cy="12" r="1.4" />
    </svg>
  )
}
