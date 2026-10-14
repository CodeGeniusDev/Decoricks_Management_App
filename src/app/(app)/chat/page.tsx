'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PageTransition } from '@/components/PageTransition'
import { Toast } from '@/components/ui/Toast'
import { ErrorState } from '@/components/ui/ErrorState'
import { IconMenu } from '@/components/ui/icons'
import { apiFetch } from '@/lib/api-client'
import { useAuth } from '@/components/auth/AuthProvider'
import { isFounder } from '@/lib/permissions-client'
import { useRealtimeSync, useConnectionState } from '@/lib/sync/useRealtime'
import { ChannelSidebar } from '@/components/chat/ChannelSidebar'
import { MessageList } from '@/components/chat/MessageList'
import { Composer } from '@/components/chat/Composer'
import { ConnectionStatus, OfflineBanner } from '@/components/chat/ConnectionStatus'
import { useKeyboardAwareHeight } from '@/components/chat/useKeyboardAwareHeight'
import {
  mergeMessages,
  newestTimestamp,
  type ChatChannel,
  type ChatMessage,
  type ServerMessage,
} from '@/components/chat/types'

const PAGE_SIZE = 50

/** Idempotency token per user intention. Reused on retry so a dropped response
 *  can never create a duplicate. */
const genClientId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `c-${Date.now()}-${Math.random().toString(36).slice(2)}`

interface Envelope<T> {
  success: boolean
  data?: T
  error?: { message?: string }
}

const readEnvelope = async <T,>(res: Response): Promise<Envelope<T>> => {
  try {
    return (await res.json()) as Envelope<T>
  } catch {
    return { success: false, error: { message: `Request failed (${res.status})` } }
  }
}

export default function ChatPage() {
  const { user } = useAuth()
  const currentUserId = user?._id ?? ''
  const canManage = isFounder(user?.role)
  const { state: connState } = useConnectionState()

  const [channels, setChannels] = useState<ChatChannel[]>([])
  const [channelsLoading, setChannelsLoading] = useState(true)
  const [channelsError, setChannelsError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [hasMoreOlder, setHasMoreOlder] = useState(false)
  const [messagesError, setMessagesError] = useState<string | null>(null)

  const [draft, setDraft] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [offline, setOffline] = useState(false)
  const [toast, setToast] = useState<{
    type: 'success' | 'error' | 'info' | 'warning'
    message: string
  } | null>(null)

  const panelRef = useRef<HTMLDivElement>(null)
  const oldestIdRef = useRef<string | null>(null)
  const lastTsRef = useRef<number>(0)
  // Guards against a slow response for a previous channel landing after the
  // user has already switched — the classic "wrong channel's messages" race.
  const reqSeq = useRef(0)
  const tailTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const channelsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useKeyboardAwareHeight(panelRef)

  const activeChannel = useMemo(
    () => channels.find((c) => c._id === activeId) ?? null,
    [channels, activeId]
  )

  /* ------------------------------- tracking ------------------------------- */

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  /* ------------------------------ channels -------------------------------- */

  const loadChannels = useCallback(async (opts: { selectFirst?: boolean } = {}) => {
    try {
      const res = await apiFetch('/api/chat/channels')
      const body = await readEnvelope<ChatChannel[]>(res)
      if (!body.success || !body.data)
        throw new Error(body.error?.message ?? 'Failed to load channels')
      const list = body.data
      setChannels(list)
      setChannelsError(null)
      setActiveId((cur) => {
        if (cur && list.some((c) => c._id === cur)) return cur
        if (opts.selectFirst && list.length) return list[0]._id
        return cur
      })
    } catch (err) {
      setChannelsError(err instanceof Error ? err.message : 'Failed to load channels')
    } finally {
      setChannelsLoading(false)
    }
  }, [])

  /* ------------------------------- messages ------------------------------- */

  const openChannel = useCallback(async (channelId: string) => {
    const seq = ++reqSeq.current
    setMessages([])
    setMessagesLoading(true)
    setMessagesError(null)
    oldestIdRef.current = null
    lastTsRef.current = 0
    setHasMoreOlder(false)
    try {
      const res = await apiFetch(`/api/chat/channels/${channelId}/messages?limit=${PAGE_SIZE}`)
      const body = await readEnvelope<ServerMessage[]>(res)
      if (seq !== reqSeq.current) return // switched away mid-flight
      if (!body.success || !body.data)
        throw new Error(body.error?.message ?? 'Failed to load messages')
      setMessages(mergeMessages([], body.data, 'tail'))
      oldestIdRef.current = body.data.length ? body.data[0]._id : null
      setHasMoreOlder(body.data.length === PAGE_SIZE)
      lastTsRef.current = newestTimestamp(body.data)
      // Opening a channel is the intent to read it.
      void apiFetch(`/api/chat/channels/${channelId}/read`, { method: 'POST', body: '{}' }).then(
        () =>
          setChannels((prev) =>
            prev.map((c) => (c._id === channelId ? { ...c, unreadCount: 0 } : c))
          )
      )
    } catch (err) {
      if (seq === reqSeq.current)
        setMessagesError(err instanceof Error ? err.message : 'Failed to load messages')
    } finally {
      if (seq === reqSeq.current) setMessagesLoading(false)
    }
  }, [])

  const loadOlder = useCallback(async () => {
    if (!activeId || !oldestIdRef.current || loadingOlder) return
    setLoadingOlder(true)
    const before = oldestIdRef.current
    try {
      const res = await apiFetch(
        `/api/chat/channels/${activeId}/messages?before=${before}&limit=${PAGE_SIZE}`
      )
      const body = await readEnvelope<ServerMessage[]>(res)
      if (!body.success || !body.data)
        throw new Error(body.error?.message ?? 'Failed to load older messages')
      if (body.data.length === 0) {
        setHasMoreOlder(false)
      } else {
        setMessages((prev) => mergeMessages(prev, body.data!, 'prepend'))
        oldestIdRef.current = body.data[0]._id
        setHasMoreOlder(body.data.length === PAGE_SIZE)
      }
    } catch (err) {
      setToast({
        type: 'error',
        message: err instanceof Error ? err.message : 'Could not load older messages',
      })
    } finally {
      setLoadingOlder(false)
    }
  }, [activeId, loadingOlder])

  const refetchTail = useCallback(async () => {
    if (!activeId) return
    const since = lastTsRef.current
    try {
      const url = since
        ? `/api/chat/channels/${activeId}/messages?since=${since}`
        : `/api/chat/channels/${activeId}/messages?limit=${PAGE_SIZE}`
      const res = await apiFetch(url)
      const body = await readEnvelope<ServerMessage[]>(res)
      if (!body.success || !body.data) return
      if (body.data.length === 0) return
      setMessages((prev) => mergeMessages(prev, body.data!, 'tail'))
      const newest = newestTimestamp(body.data)
      if (newest > lastTsRef.current) lastTsRef.current = newest
    } catch {
      /* a hiccup in the live tail is retried on the next signal or poll tick */
    }
  }, [activeId])

  /* -------------------------------- sending ------------------------------- */

  const postMessage = useCallback(
    async (row: ChatMessage) => {
      if (!activeId) return
      try {
        const res = await apiFetch(`/api/chat/channels/${activeId}/messages`, {
          method: 'POST',
          body: JSON.stringify({ content: row.content, clientId: row.clientId }),
        })
        const body = await readEnvelope<ServerMessage>(res)
        if (res.status === 429) {
          setMessages((prev) =>
            prev.map((m) => (m.tempId === row.tempId ? { ...m, status: 'failed' } : m))
          )
          setToast({
            type: 'warning',
            message: body.error?.message ?? 'Sending too quickly — slow down.',
          })
          return
        }
        if (!body.success || !body.data) throw new Error(body.error?.message ?? 'Failed to send')
        // The authoritative row replaces the optimistic one (matched by clientId).
        setMessages((prev) => mergeMessages(prev, [body.data!], 'tail'))
        const ts = Date.parse(body.data.createdAt)
        if (ts > lastTsRef.current) lastTsRef.current = ts
      } catch (err) {
        setMessages((prev) =>
          prev.map((m) => (m.tempId === row.tempId ? { ...m, status: 'failed' } : m))
        )
        setToast({
          type: 'error',
          message: err instanceof Error ? err.message : 'Message failed to send',
        })
      }
    },
    [activeId]
  )

  const sendMessage = useCallback(() => {
    const text = draft.trim()
    if (!text || !activeId || !user || offline) return
    const clientId = genClientId()
    const optimistic: ChatMessage = {
      _id: '',
      tempId: clientId,
      clientId,
      channelId: activeId,
      senderId: currentUserId,
      senderName: user.name,
      content: text,
      isSystem: false,
      isDeleted: false,
      editable: true,
      createdAt: new Date().toISOString(),
      status: 'sending',
    }
    setDraft('')
    setMessages((prev) => [...prev, optimistic])
    void postMessage(optimistic)
  }, [draft, activeId, user, offline, currentUserId, postMessage])

  const retryMessage = useCallback(
    (row: ChatMessage) => {
      setMessages((prev) =>
        prev.map((m) => (m.tempId === row.tempId ? { ...m, status: 'sending' } : m))
      )
      void postMessage(row)
    },
    [postMessage]
  )

  /* ---------------------------- edit / moderate --------------------------- */

  const editMessage = useCallback(
    async (id: string, content: string) => {
      if (!activeId) return
      try {
        const res = await apiFetch(`/api/chat/channels/${activeId}/messages/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ content }),
        })
        const body = await readEnvelope<ServerMessage>(res)
        if (!body.success || !body.data)
          throw new Error(body.error?.message ?? 'Failed to edit message')
        setMessages((prev) =>
          prev.map((m) => (m._id === id ? { ...m, ...body.data, status: 'sent' } : m))
        )
      } catch (err) {
        setToast({
          type: 'error',
          message: err instanceof Error ? err.message : 'Failed to edit message',
        })
        throw err
      }
    },
    [activeId]
  )

  const deleteMessage = useCallback(
    async (id: string) => {
      if (!activeId) return
      try {
        const res = await apiFetch(`/api/chat/channels/${activeId}/messages/${id}`, {
          method: 'DELETE',
        })
        const body = await readEnvelope<ServerMessage>(res)
        if (!body.success) throw new Error(body.error?.message ?? 'Failed to delete message')
        setMessages((prev) =>
          prev.map((m) =>
            m._id === id
              ? { ...m, isDeleted: true, content: null as unknown as string, editable: false }
              : m
          )
        )
      } catch (err) {
        setToast({
          type: 'error',
          message: err instanceof Error ? err.message : 'Failed to delete message',
        })
      }
    },
    [activeId]
  )

  /* --------------------------- channel management ------------------------- */

  const createChannel = useCallback(async (name: string, description: string): Promise<boolean> => {
    try {
      const res = await apiFetch('/api/chat/channels', {
        method: 'POST',
        body: JSON.stringify({ name, description: description || undefined }),
      })
      const body = await readEnvelope<ChatChannel>(res)
      if (!body.success || !body.data)
        throw new Error(body.error?.message ?? 'Failed to create channel')
      setChannels((prev) => [...prev, body.data!])
      setActiveId(body.data._id)
      setToast({ type: 'success', message: `Created #${body.data.name}` })
      return true
    } catch (err) {
      setToast({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to create channel',
      })
      return false
    }
  }, [])

  const archiveChannel = useCallback(
    async (id: string) => {
      try {
        const res = await apiFetch(`/api/chat/channels/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ isArchived: true }),
        })
        const body = await readEnvelope(res)
        if (!body.success) throw new Error(body.error?.message ?? 'Failed to archive channel')
        const remaining = channels.filter((c) => c._id !== id)
        setChannels(remaining)
        if (id === activeId) {
          if (remaining.length) setActiveId(remaining[0]._id)
          else setActiveId(null)
        }
        setToast({ type: 'success', message: 'Channel archived' })
      } catch (err) {
        setToast({
          type: 'error',
          message: err instanceof Error ? err.message : 'Failed to archive channel',
        })
      }
    },
    [channels, activeId]
  )

  /* ------------------------------ lifecycle ------------------------------- */

  useEffect(() => {
    if (!user) return
    void loadChannels({ selectFirst: true })
  }, [user, loadChannels])

  useEffect(() => {
    if (!user || !activeId) return
    void openChannel(activeId)
    // Re-open only when the selected channel changes, not on every channels poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, activeId])

  /* ------------------------- live updates (SSE/poll) ---------------------- */

  useRealtimeSync(
    'chat',
    () => {
      // Debounce the tail refetch so a burst of changes is one fetch, not many.
      if (tailTimer.current) clearTimeout(tailTimer.current)
      tailTimer.current = setTimeout(() => void refetchTail(), 300)
      // Refresh unread badges for the other channels a little less eagerly.
      if (channelsTimer.current) clearTimeout(channelsTimer.current)
      channelsTimer.current = setTimeout(() => void loadChannels(), 1200)
    },
    user != null
  )

  useEffect(() => {
    return () => {
      if (tailTimer.current) clearTimeout(tailTimer.current)
      if (channelsTimer.current) clearTimeout(channelsTimer.current)
    }
  }, [])

  /* -------------------------------- render -------------------------------- */

  const canModify = useCallback((m: ChatMessage) => Boolean(m.editable), [])
  const sendingDisabled = !activeId || offline || !user || connState === 'offline'

  const rail = (
    <ChannelSidebar
      channels={channels}
      activeId={activeId}
      loading={channelsLoading}
      canManage={canManage}
      onSelect={(id) => {
        setActiveId(id)
        setSidebarOpen(false)
      }}
      onCreate={createChannel}
      onArchive={archiveChannel}
    />
  )

  return (
    <PageTransition>
      {toast && (
        <div className="fixed right-4 top-20 z-50">
          <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
        </div>
      )}

      <div
        ref={panelRef}
        className="relative flex h-[calc(100dvh-8.5rem)] min-h-[420px] gap-0 overflow-hidden rounded-xl border border-line-subtle bg-surface-raised md:h-[calc(100dvh-9rem)]"
      >
        {/* Desktop rail */}
        <aside className="hidden w-64 shrink-0 border-r border-line-subtle md:block">{rail}</aside>

        {/* Mobile drawer */}
        {sidebarOpen && (
          <div className="absolute inset-0 z-30 flex md:hidden" role="dialog" aria-label="Channels">
            <button
              type="button"
              aria-label="Close channels"
              className="flex-1 bg-decoricks-black/40"
              onClick={() => setSidebarOpen(false)}
            />
            <div className="w-64 max-w-[80%] border-r border-line-subtle bg-surface-raised">
              {rail}
            </div>
          </div>
        )}

        {/* Conversation panel */}
        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-2 border-b border-line-subtle px-3 py-2.5">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open channels"
              className="inline-flex h-11 w-11 items-center justify-center rounded-md text-ink-secondary hover:bg-surface-sunken md:hidden"
            >
              <IconMenu className="h-5 w-5" />
            </button>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-sm font-semibold text-ink">
                {activeChannel ? `#${activeChannel.name}` : 'Team Chat'}
              </h1>
              {activeChannel?.description && (
                <p className="truncate text-xs text-ink-muted">{activeChannel.description}</p>
              )}
            </div>
            <ConnectionStatus />
          </header>

          <OfflineBanner offline={offline} />

          {channelsError ? (
            <div className="p-4">
              <ErrorState
                title="Could not load channels"
                description={channelsError}
                action={{ label: 'Try again', onClick: () => void loadChannels() }}
              />
            </div>
          ) : !activeId ? (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-ink-muted">
              {channelsLoading
                ? 'Loading channels…'
                : 'No channels yet. Ask the Founder to create one.'}
            </div>
          ) : (
            <>
              {messagesError ? (
                <div className="p-4">
                  <ErrorState
                    title="Could not load messages"
                    description={messagesError}
                    action={{ label: 'Try again', onClick: () => void openChannel(activeId) }}
                  />
                </div>
              ) : (
                <MessageList
                  messages={messages}
                  currentUserId={currentUserId}
                  loading={messagesLoading}
                  hasMoreOlder={hasMoreOlder}
                  loadingOlder={loadingOlder}
                  onLoadOlder={() => void loadOlder()}
                  canModify={canModify}
                  onEdit={editMessage}
                  onDelete={deleteMessage}
                  onRetry={(row) => retryMessage(row)}
                />
              )}

              <div className="border-t border-line-subtle p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
                <Composer
                  value={draft}
                  onChange={setDraft}
                  onSend={sendMessage}
                  disabled={sendingDisabled}
                />
              </div>
            </>
          )}
        </section>
      </div>
    </PageTransition>
  )
}
