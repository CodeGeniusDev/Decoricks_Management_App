'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { IconPlus, IconArchive } from '@/components/ui/icons'
import type { ChatChannel } from './types'

interface SidebarProps {
  channels: ChatChannel[]
  activeId: string | null
  loading: boolean
  canManage: boolean
  /** A closed room is open in the panel; keeps the Archived entry marked. */
  viewingArchived: boolean
  onSelect: (id: string) => void
  onCreate: (name: string, description: string) => Promise<boolean>
  onArchive: (id: string) => Promise<void>
  onOpenArchived: () => void
}

/**
 * Channel rail. Unread counts come straight from the list endpoint. The
 * Founder-only affordances (new channel, archive) are shown when `canManage`
 * is true, but that flag is presentational — the mutating routes re-check
 * Founder-ness server-side, so hiding them here is UX, not security.
 *
 * The Archived Chats entry is a permanent footer rather than a hover control:
 * the whole bug it fixes was that archiving a room removed its only trace, so
 * the way back must be visible without requiring anyone to discover it.
 */
export function ChannelSidebar({
  channels,
  activeId,
  loading,
  canManage,
  viewingArchived,
  onSelect,
  onCreate,
  onArchive,
  onOpenArchived,
}: SidebarProps) {
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const reset = () => {
    setName('')
    setDescription('')
    setCreateError(null)
  }

  const submit = async () => {
    if (!name.trim() || creating) return
    setCreating(true)
    setCreateError(null)
    const ok = await onCreate(name.trim(), description.trim())
    setCreating(false)
    if (ok) {
      reset()
      setCreateOpen(false)
    } else {
      setCreateError('Could not create the channel. That name may already exist.')
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line-subtle px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Channels</h2>
        {canManage && (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            aria-label="New channel"
            className="inline-flex h-11 w-11 items-center justify-center rounded-md text-ink-muted hover:bg-surface-sunken hover:text-ink lg:h-8 lg:w-8"
          >
            <IconPlus className="h-4 w-4" />
          </button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto p-2" aria-label="Chat channels">
        {loading ? (
          <p className="px-2 py-4 text-sm text-ink-muted">Loading…</p>
        ) : channels.length === 0 ? (
          <p className="px-2 py-4 text-sm text-ink-muted">No channels yet.</p>
        ) : (
          <ul className="space-y-1">
            {channels.map((c) => {
              const active = c._id === activeId
              return (
                <li key={c._id} className="group">
                  <div
                    className={`flex items-center gap-2 rounded-lg ${
                      active
                        ? 'bg-decoricks-brown text-decoricks-light'
                        : 'text-ink-secondary hover:bg-surface-sunken'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(c._id)}
                      aria-current={active ? 'true' : undefined}
                      className="flex min-h-[44px] flex-1 items-center gap-2 px-3 py-2 text-left"
                    >
                      <span className="flex-1 truncate text-sm font-medium" title={`#${c.name}`}>
                        #{c.name}
                      </span>
                      {c.unreadCount > 0 && (
                        <span
                          className={`min-w-[20px] rounded-full px-1.5 py-0.5 text-center text-2xs font-bold ${
                            active
                              ? 'bg-decoricks-light text-decoricks-brown'
                              : 'bg-status-danger text-white'
                          }`}
                        >
                          {c.unreadCount > 99 ? '99+' : c.unreadCount}
                        </span>
                      )}
                    </button>
                    {canManage && (
                      <button
                        type="button"
                        onClick={() => onArchive(c._id)}
                        aria-label={`Archive ${c.name}`}
                        title="Archive channel"
                        /* Hover reveals nothing on a touchscreen, and archiving had
                           better not be a desktop-only verb: visible always, tidy on
                           pointer devices. */
                        className="mr-1 inline-flex h-9 w-9 items-center justify-center rounded-md text-decoricks-light/70 hover:bg-decoricks-light/20 md:hidden md:group-hover:inline-flex"
                      >
                        <IconArchive className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </nav>

      {canManage && (
        <div className="border-t border-line-subtle p-2">
          <button
            type="button"
            onClick={onOpenArchived}
            aria-label="Open archived chats"
            className={`flex min-h-[44px] w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium ${
              viewingArchived
                ? 'bg-surface-sunken text-ink'
                : 'text-ink-muted hover:bg-surface-sunken hover:text-ink-secondary'
            }`}
          >
            <IconArchive className="h-4 w-4 shrink-0" />
            <span className="flex-1">Archived Chats</span>
          </button>
        </div>
      )}

      <Modal
        isOpen={createOpen}
        onClose={() => {
          setCreateOpen(false)
          reset()
        }}
        title="New channel"
        description="Channels are visible to all four team members."
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setCreateOpen(false)
                reset()
              }}
            >
              Cancel
            </Button>
            <Button variant="primary" loading={creating} onClick={submit} disabled={!name.trim()}>
              Create
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Projects"
            maxLength={80}
          />
          <Input
            label="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={200}
          />
          {createError && <p className="text-sm text-status-danger">{createError}</p>}
        </div>
      </Modal>
    </div>
  )
}
