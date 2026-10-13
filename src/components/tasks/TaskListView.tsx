'use client'

import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'

/**
 * TaskListView — the flat list behind the "My tasks" and "Overdue" board views.
 *
 * The board (dnd-kit columns) is the right metaphor when you are moving work
 * between stages, but "what is on me?" and "what has slipped?" are questions
 * about a filtered *set*, not a pipeline. This view answers them with a simple,
 * sortable list that reuses the same edit modal the board opens.
 *
 * It is deliberately presentational: the parent owns fetching, filtering and
 * the modal. We only need the resolved names for assignees and labels so the
 * rows are readable — the API returns ids, the parent already has the lookup
 * tables for the filter bar, so we pass them down rather than refetching here.
 */

export interface ListTask {
  _id: string
  taskNumber?: string
  title: string
  priority: 'low' | 'medium' | 'high' | 'urgent'
  dueDate?: string | null
  assigneeIds: string[]
  labelIds: string[]
  completedAt?: string | null
}

interface TaskListViewProps {
  tasks: ListTask[]
  loading: boolean
  /** Id → display name, resolved by the parent from /api/users + /api/task-labels. */
  userNames: Map<string, string>
  labelNames: Map<string, string>
  emptyTitle: string
  emptyDescription: string
  onOpen: (task: ListTask) => void
}

const PRIORITY_LABEL: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
}

const PRIORITY_CLASS: Record<string, string> = {
  low: 'border-l-4 border-l-slate-300',
  medium: 'border-l-4 border-l-blue-300',
  high: 'border-l-4 border-l-amber-400',
  urgent: 'border-l-4 border-l-rose-500',
}

/** Karachi-local calendar day boundary; the SPEC evaluates overdue at day end. */
function isOverdue(dueDate: string | null | undefined, nowMs: number): boolean {
  if (!dueDate) return false
  return new Date(dueDate).getTime() < nowMs
}

function dateLabel(dueDate: string | null | undefined): string {
  if (!dueDate) return 'No due date'
  return new Date(dueDate).toISOString().slice(0, 10)
}

export function TaskListView(props: TaskListViewProps) {
  const { tasks, loading, userNames, labelNames, emptyTitle, emptyDescription, onOpen } = props

  if (loading) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
    )
  }

  if (tasks.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />
  }

  const now = Date.now()

  return (
    <ul className="flex flex-col gap-2">
      {tasks.map((t) => {
        const overdue = isOverdue(t.dueDate, now)
        const assignees = t.assigneeIds.map((id) => userNames.get(id) ?? `User ${id.slice(-4)}`)
        const labels = t.labelIds.map((id) => labelNames.get(id)).filter((n): n is string => Boolean(n))
        return (
          <li key={t._id}>
            <button
              type="button"
              onClick={() => onOpen(t)}
              className={`flex w-full flex-col gap-1.5 rounded-lg border border-line-subtle bg-surface-raised p-3 text-left shadow-sm transition-shadow hover:shadow focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-decoricks-brown ${PRIORITY_CLASS[t.priority] ?? ''}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-decoricks-dark">{t.title}</p>
                  {t.taskNumber && (
                    <p className="mt-0.5 text-xs text-ink-muted tabular-nums">{t.taskNumber}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Badge
                    size="sm"
                    variant={
                      t.priority === 'urgent'
                        ? 'error'
                        : t.priority === 'high'
                          ? 'warning'
                          : 'default'
                    }
                  >
                    {PRIORITY_LABEL[t.priority]}
                  </Badge>
                  <span
                    className={`text-xs tabular-nums ${overdue ? 'font-semibold text-rose-600' : 'text-ink-muted'}`}
                  >
                    {overdue ? '⚠ ' : ''}
                    {dateLabel(t.dueDate)}
                  </span>
                </div>
              </div>
              {(assignees.length > 0 || labels.length > 0) && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {assignees.map((name) => (
                    <span
                      key={name}
                      className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-secondary"
                    >
                      {name}
                    </span>
                  ))}
                  {labels.map((name) => (
                    <span key={name} className="text-xs text-ink-muted">
                      #{name}
                    </span>
                  ))}
                </div>
              )}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
