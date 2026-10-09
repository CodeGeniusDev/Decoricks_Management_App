'use client'

import { IconPlus } from '@/components/ui/icons'
import { useState, useEffect, useCallback, useRef } from 'react'
import { PageTransition } from '@/components/PageTransition'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Select } from '@/components/ui/Select'
import { Badge } from '@/components/ui/Badge'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { Toast } from '@/components/ui/Toast'
import { Modal } from '@/components/ui/Modal'
import { ASSIGNEE_OPTIONS, roleLabel } from '@/lib/roles'
import { apiFetch } from '@/lib/api-client'

interface Task {
  _id: string
  taskNumber?: string
  title: string
  description?: string
  status: 'todo' | 'in_progress' | 'review' | 'done'
  priority: 'low' | 'medium' | 'high'
  /** Team role (see lib/roles) — not a fabricated user record. */
  assigneeName?: string
  dueDate?: string
  createdAt: string
  updatedAt: string
}

interface TaskSummary {
  total: number
  todo: number
  inProgress: number
  review: number
  done: number
  overdue: number
}

const COLUMNS: { id: Task['status']; title: string; color: string }[] = [
  { id: 'todo', title: 'To Do', color: 'bg-gray-100' },
  { id: 'in_progress', title: 'In Progress', color: 'bg-blue-50' },
  { id: 'review', title: 'Review', color: 'bg-yellow-50' },
  { id: 'done', title: 'Done', color: 'bg-green-50' },
]

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [summary, setSummary] = useState<TaskSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const isSubmittingRef = useRef(false)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [toastMessage, setToastMessage] = useState<{
    type: 'success' | 'error' | 'info' | 'warning'
    message: string
  } | null>(null)

  // Form state preserved across modal open/close
  const [formTitle, setFormTitle] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formPriority, setFormPriority] = useState<'low' | 'medium' | 'high'>('medium')
  const [formAssigneeRole, setFormAssigneeRole] = useState('')
  const [formDueDate, setFormDueDate] = useState('')
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})

  const fetchTasks = useCallback(async () => {
    try {
      setLoading(true)
      setLoadError(null)
      const res = await apiFetch('/api/tasks')
      const body = await res.json()
      if (!res.ok || !body.success) {
        throw new Error(body?.error?.message || 'Failed to load tasks')
      }
      setTasks(body.data.tasks)
      setSummary(body.data.summary)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load tasks')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchTasks()
  }, [fetchTasks])

  const tasksByColumn = (status: Task['status']) => {
    return tasks.filter((t) => t.status === status)
  }

  const openModal = () => {
    setEditingTask(null)
    setFormTitle('')
    setFormDescription('')
    setFormPriority('medium')
    setFormAssigneeRole('')
    setFormDueDate('')
    setFormErrors({})
    setIsModalOpen(true)
  }

  const openEditModal = (task: Task) => {
    setEditingTask(task)
    setFormTitle(task.title)
    setFormDescription(task.description || '')
    setFormPriority(task.priority)
    setFormAssigneeRole(task.assigneeName || '')
    setFormDueDate(task.dueDate ? task.dueDate.slice(0, 10) : '')
    setFormErrors({})
    setIsModalOpen(true)
  }

  const closeModal = () => {
    setIsModalOpen(false)
    setEditingTask(null)
  }

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {}
    if (!formTitle.trim()) errors.title = 'Title is required'
    if (!formDueDate) errors.dueDate = 'Due date is required'
    setFormErrors(errors)
    return Object.keys(errors).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (isSubmittingRef.current) return
    if (!validateForm()) return

    isSubmittingRef.current = true
    setIsSubmitting(true)
    try {
      const payload = {
        title: formTitle.trim(),
        description: formDescription.trim() || undefined,
        priority: formPriority,
        assigneeName: formAssigneeRole || undefined,
        dueDate: formDueDate,
      }

      const res = await apiFetch(editingTask ? `/api/tasks/${editingTask._id}` : '/api/tasks', {
        method: editingTask ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json()

      if (!res.ok || !body.success) {
        // Keep the form filled so the user can retry without retyping.
        if (Array.isArray(body?.error?.details)) {
          const fieldErrors: Record<string, string> = {}
          for (const d of body.error.details) {
            if (d?.path) fieldErrors[d.path] = d.message
          }
          setFormErrors(fieldErrors)
        }
        throw new Error(body?.error?.message || 'Could not save task')
      }

      setToastMessage({
        type: 'success',
        message: editingTask ? 'Task updated successfully' : 'Task created successfully',
      })
      closeModal()
      await fetchTasks()
    } catch (err) {
      setFormErrors((prev) => ({
        ...prev,
        general: err instanceof Error ? err.message : 'Could not save task',
      }))
    } finally {
      isSubmittingRef.current = false
      setIsSubmitting(false)
    }
  }

  const moveTask = async (taskId: string, newStatus: Task['status']) => {
    const previous = tasks
    // Optimistic update, rolled back if the write fails.
    setTasks((current) => current.map((t) => (t._id === taskId ? { ...t, status: newStatus } : t)))

    try {
      const res = await apiFetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      const body = await res.json()
      if (!res.ok || !body.success) {
        setTasks(previous)
        throw new Error(body?.error?.message || 'Could not update task status')
      }
      setSummary((s) =>
        s ? { ...s, total: s.total, done: s.done, todo: s.todo, inProgress: s.inProgress, review: s.review } : s
      )
      await fetchTasks()
    } catch (err) {
      setTasks(previous)
      setToastMessage({
        type: 'error',
        message: err instanceof Error ? err.message : 'Could not update task status',
      })
    }
  }

  const deleteTask = async (taskId: string) => {
    if (!confirm('Are you sure you want to delete this task?')) return

    const previous = tasks
    setTasks((current) => current.filter((t) => t._id !== taskId))

    try {
      const res = await apiFetch(`/api/tasks/${taskId}`, { method: 'DELETE' })
      const body = await res.json()
      if (!res.ok || !body.success) {
        setTasks(previous)
        throw new Error(body?.error?.message || 'Could not delete task')
      }
      setToastMessage({ type: 'success', message: 'Task deleted' })
      await fetchTasks()
    } catch (err) {
      setTasks(previous)
      setToastMessage({
        type: 'error',
        message: err instanceof Error ? err.message : 'Could not delete task',
      })
    }
  }

  const getPriorityBadge = (priority: Task['priority']) => {
    const variant = priority === 'high' ? 'error' : priority === 'medium' ? 'warning' : 'default'
    return <Badge variant={variant}>{priority}</Badge>
  }

  if (loading) {
    return (
      <PageTransition>
        <h1 className="text-2xl font-bold text-decoricks-dark mb-6">Tasks</h1>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {COLUMNS.map((col) => (
            <div key={col.id}>
              <Skeleton variant="rect" className="h-6 w-3/4 mb-2" />
              <Skeleton variant="rect" className="h-48" />
            </div>
          ))}
        </div>
      </PageTransition>
    )
  }

  return (
    <PageTransition>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-decoricks-dark">Tasks</h1>
        <Button variant="primary" onClick={openModal} type="button"
        >
          <IconPlus size={16}  />
          New Task
        </Button>
      </div>

      {/* Toast */}
      {toastMessage && (
        <div className="fixed top-20 right-4 z-50">
          <Toast
            message={toastMessage.message}
            type={toastMessage.type}
            onClose={() => setToastMessage(null)}
          />
        </div>
      )}

      {loadError && (
        <Card variant="default" className="p-6 mb-6 border-red-200">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-decoricks-dark">Could not load tasks</h2>
              <p className="text-sm text-decoricks-dark/60">{loadError}</p>
            </div>
            <Button variant="outline" onClick={fetchTasks} type="button">
              Try again
            </Button>
          </div>
        </Card>
      )}

      {!loadError && summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          {[
            { label: 'To do', value: summary.todo },
            { label: 'In progress', value: summary.inProgress },
            { label: 'Done', value: summary.done },
            { label: 'Overdue', value: summary.overdue },
          ].map((stat) => (
            <Card key={stat.label} variant="default" className="p-4" animate={false}>
              <p className="text-xs uppercase tracking-wide text-decoricks-dark/50">{stat.label}</p>
              <p className="text-2xl font-bold text-decoricks-dark">{stat.value}</p>
            </Card>
          ))}
        </div>
      )}

      {/* Kanban Board */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {COLUMNS.map((column) => (
          <div key={column.id} className={`${column.color} rounded-lg p-3 min-h-[500px]`}>
            <h3 className="font-semibold text-decoricks-dark mb-3 text-center">
              {column.title}
            </h3>
            <div className="space-y-3">
              {tasksByColumn(column.id).map((task) => (
                <Card
                  key={task._id}
                  variant={column.id === 'done' ? 'default' : 'default'}
                  className="p-3 cursor-pointer"
                  animate={false}
                >
                  <div className="flex justify-between items-start mb-2">
                    <h4 className="font-medium text-sm text-decoricks-dark">{task.title}</h4>
                    {getPriorityBadge(task.priority)}
                  </div>
                  {task.description && (
                    <p className="text-xs text-decoricks-dark/60 mb-2 line-clamp-2">
                      {task.description}
                    </p>
                  )}
                  {task.dueDate && (
                    <p
                      className={`text-xs mb-2 ${
                        summary?.overdue && task.status !== 'done'
                          ? 'text-red-500'
                          : 'text-decoricks-dark/60'
                      }`}
                    >
                      Due: {new Date(task.dueDate).toLocaleDateString()}
                    </p>
                  )}
                  <div className="flex justify-between items-center">
                    {task.assigneeName && (
                      <Badge variant="default" size="sm">
                        {task.assigneeName}
                      </Badge>
                    )}
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => openEditModal(task)}
                        className="text-xs text-decoricks-brown hover:underline"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteTask(task._id)}
                        className="text-xs text-red-500 hover:underline"
                      >
                        Del
                      </button>
                    </div>
                  </div>

                  {/* Quick status change - no page reload */}
                  {column.id !== 'done' && (
                    <div className="mt-2 pt-2 border-t border-decoricks-black/5 flex gap-1 flex-wrap">
                      {COLUMNS.filter((c) => c.id !== column.id && c.id !== 'done').map((c) => (
                        <button
                          type="button"
                          key={c.id}
                          onClick={(e) => {
                            e.stopPropagation()
                            moveTask(task._id, c.id)
                          }}
                          className="text-xs px-2 py-0.5 rounded bg-decoricks-dark/5 hover:bg-decoricks-dark/10 transition-colors"
                        >
                          → {c.title}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          moveTask(task._id, 'done')
                        }}
                        className="text-xs px-2 py-0.5 rounded bg-green-100 hover:bg-green-200 text-green-700 transition-colors"
                      >
                        ✓ Done
                      </button>
                    </div>
                  )}
                </Card>
              ))}

              {tasksByColumn(column.id).length === 0 && (
                <div className="text-center py-8 text-sm text-decoricks-dark/40">
                  No tasks in {column.title}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {!loading && !loadError && tasks.length === 0 && (
        <EmptyState
          title="No tasks yet"
          description="Create your first task to start tracking work. Nothing here is sample data — this board only shows tasks you add."
          action={{ label: 'New Task', onClick: openModal }}
        />
      )}

      {/* Add/Edit Task Modal — uses the shared Modal so the overlay is portaled
        to <body> (a transformed page container would otherwise capture
        position: fixed) and only exists while open, so its form is never a
        hidden, focusable form living in the page background. */}
      <Modal
        isOpen={isModalOpen}
        onClose={closeModal}
        title={editingTask ? 'Edit Task' : 'New Task'}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
                <Input
                  label="Title"
                  placeholder="Enter task title..."
                  value={formTitle}
                  onChange={(e) => setFormTitle(e.target.value)}
                  error={formErrors.title}
                />
                <Textarea
                  label="Description (optional)"
                  placeholder="Enter description..."
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  rows={3}
                />
                <Select
                  label="Priority"
                  options={PRIORITY_OPTIONS}
                  value={formPriority}
                  onChange={(e) => setFormPriority(e.target.value as any)}
                />
                <Select
                  label="Assignee"
                  options={ASSIGNEE_OPTIONS}
                  value={formAssigneeRole}
                  onChange={(e) => setFormAssigneeRole(e.target.value)}
                />
                <Input
                  label="Due Date"
                  type="date"
                  value={formDueDate}
                  onChange={(e) => setFormDueDate(e.target.value)}
                  error={formErrors.dueDate}
                />

                {formErrors.general && (
                  <p className="text-sm text-red-500">{formErrors.general}</p>
                )}

                <div className="flex justify-end gap-2 pt-4">
                  <Button variant="outline" onClick={closeModal} type="button">
                    Cancel
                  </Button>
                  <Button variant="primary" type="submit" disabled={isSubmitting}>
                    {isSubmitting ? 'Saving…' : editingTask ? 'Update Task' : 'Create Task'}
                  </Button>
                </div>
        </form>
      </Modal>
    </PageTransition>
  )
}
