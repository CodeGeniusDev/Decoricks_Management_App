'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PageTransition } from '@/components/PageTransition'
import { Toast } from '@/components/ui/Toast'
import { ErrorState } from '@/components/ui/ErrorState'
import { IconArchive, IconClose, IconMenu, IconRefresh } from '@/components/ui/icons'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { apiFetch } from '@/lib/api-client'
import { useAuth } from '@/components/auth/AuthProvider'
import { isFounder } from '@/lib/permissions-client'
import { useRealtimeSync, useConnectionState } from '@/lib/sync/useRealtime'
import { ChannelSidebar } from '@/components/chat/ChannelSidebar'
import { ArchivedChatsModal } from '@/components/chat/ArchivedChatsModal'
import { MessageList } from '@/components/chat/MessageList'
import { Composer } from '@/components/chat/Composer'
import { ConnectionStatus, OfflineBanner } from '@/components/chat/ConnectionStatus'
import { useKeyboardAwareHeight } from '@/components/chat/useKeyboardAwareHeight'
import {
  mergeMessages,
  newestTimestamp,
  referenceKey,
  type ChatChannel,
  type ChatMessage,
  type MentionMember,
  type ReferenceCandidate,
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
  /** Directory behind `@`. Fetched once per session; the composer never guesses. */
  const [members, setMembers] = useState<MentionMember[]>([])
  /** Records queued for the next message, attached but not yet sent. */
  const [pendingRefs, setPendingRefs] = useState<ReferenceCandidate[]>([])
  const [archivedListOpen, setArchivedListOpen] = useState(false)
  /** Non-null while a closed room is open read-only in the panel. */
  const [archivedRoom, setArchivedRoom] = useState<ChatChannel | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [offline, setOffline] = useState(false)
  const [toast, setToast] = useState<{
    type: 'success' | 'error' | 'info' | 'warning'
    message: string
  } | null>(null)

  const panelRef = useRef<HTMLDivElement>(null)
  const oldestIdRef = useRef<string | null>(null)
  const lastTsRef = useRef<number>(0)
  /** `?channel=` from a mention notification, consumed by the first channel load. */
  const deepLinkRef = useRef<string | null>(
    typeof window === 'undefined'
      ? null
      : new URLSearchParams(window.location.search).get('channel')
  )
  const deepLinkResolvedRef = useRef(false)
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

  /* Exactly one of the two is ever in view: an open channel, or a closed room
     fetched through the Founder-only archived path. Every message call takes its
     id and its `?archived=` flag from here, so the two modes cannot mix. */
  const viewingRoomId = archivedRoom?._id ?? activeId
  const viewingArchived = archivedRoom !== null

  /** Every channel this device has listed this session, keyed by id, so a room
   *  that has left the list can still be named while its messages stay on screen. */
  const knownChannelsRef = useRef(new Map<string, ChatChannel>())

  /* There is no delete endpoint for a channel — leaving the list means one thing
     only: the Founder closed it. So when the room in view suddenly disappears
     from a freshly loaded list, this device is looking at a conversation that was
     archived on another one. Its history stays on screen and the panel goes to
     the same read-only behaviour as the explicit archived view, instead of
     leaving a composer that can only fail. */
  const activeVanished =
    !archivedRoom &&
    activeId !== null &&
    !channelsLoading &&
    channelsError === null &&
    !activeChannel
  /** True whenever the conversation on screen is closed, however it got there. */
  const closedOnScreen = viewingArchived || activeVanished
  const retainedChannel =
    activeVanished && activeId ? (knownChannelsRef.current.get(activeId) ?? null) : null

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
      for (const c of list) knownChannelsRef.current.set(c._id, c)
      setChannels(list)
      setChannelsError(null)
      setActiveId((cur) => {
        if (cur && list.some((c) => c._id === cur)) return cur
        // A notification link wins over "open the first channel": the reader
        // asked for a specific conversation, and selecting another one first
        // would fetch a room they never clicked on.
        const wanted = deepLinkRef.current
        if (opts.selectFirst && wanted && list.some((c) => c._id === wanted)) {
          return wanted
        }
        if (opts.selectFirst && list.length) return list[0]._id
        return cur
      })
    } catch (err) {
      setChannelsError(err instanceof Error ? err.message : 'Failed to load channels')
    } finally {
      setChannelsLoading(false)
    }
  }, [])

  /** Mention directory for the composer. One fetch per session; a failure here
   *  only costs autocomplete, so it is silent by design. */
  const loadMembers = useCallback(async () => {
    try {
      const res = await apiFetch('/api/chat/members')
      const body = await readEnvelope<MentionMember[]>(res)
      if (body.success && body.data) setMembers(body.data)
    } catch {
      /* the composer still accepts typed text without the dropdown */
    }
  }, [])

  /* ------------------------------- messages ------------------------------- */

  const openRoom = useCallback(async (channelId: string, archived: boolean) => {
    const seq = ++reqSeq.current
    setMessages([])
    setMessagesLoading(true)
    setMessagesError(null)
    oldestIdRef.current = null
    lastTsRef.current = 0
    setHasMoreOlder(false)
    try {
      const flag = archived ? '&archived=true' : ''
      const res = await apiFetch(
        `/api/chat/channels/${channelId}/messages?limit=${PAGE_SIZE}${flag}`
      )
      const body = await readEnvelope<ServerMessage[]>(res)
      if (seq !== reqSeq.current) return // switched away mid-flight
      if (!body.success || !body.data)
        throw new Error(body.error?.message ?? 'Failed to load messages')
      setMessages(mergeMessages([], body.data, 'tail'))
      oldestIdRef.current = body.data.length ? body.data[0]._id : null
      setHasMoreOlder(body.data.length === PAGE_SIZE)
      lastTsRef.current = newestTimestamp(body.data)
      // Opening a channel is the intent to read it. A closed room is not in the
      // unread model at all — it is not something the team is catching up on.
      if (!archived) {
        void apiFetch(`/api/chat/channels/${channelId}/read`, { method: 'POST', body: '{}' }).then(
          () =>
            setChannels((prev) =>
              prev.map((c) => (c._id === channelId ? { ...c, unreadCount: 0 } : c))
            )
        )
      }
    } catch (err) {
      if (seq === reqSeq.current)
        setMessagesError(err instanceof Error ? err.message : 'Failed to load messages')
    } finally {
      if (seq === reqSeq.current) setMessagesLoading(false)
    }
  }, [])

  const loadOlder = useCallback(async () => {
    if (!viewingRoomId || !oldestIdRef.current || loadingOlder) return
    setLoadingOlder(true)
    const before = oldestIdRef.current
    try {
      // A room closed on another device is only readable through the archived
      // path, and that path is Founder-only — the control is hidden otherwise.
      const flag = viewingArchived || activeVanished ? '&archived=true' : ''
      const res = await apiFetch(
        `/api/chat/channels/${viewingRoomId}/messages?before=${before}&limit=${PAGE_SIZE}${flag}`
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
  }, [viewingRoomId, viewingArchived, activeVanished, loadingOlder])

  const refetchTail = useCallback(async () => {
    // A closed room cannot receive messages, so there is no tail to follow — and
    // the ordinary read path does not serve one, so this fetch must not be made.
    if (!viewingRoomId || closedOnScreen) return
    const since = lastTsRef.current
    const flag = viewingArchived ? '&archived=true' : ''
    try {
      const url = since
        ? `/api/chat/channels/${viewingRoomId}/messages?since=${since}${flag}`
        : `/api/chat/channels/${viewingRoomId}/messages?limit=${PAGE_SIZE}${flag}`
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
  }, [viewingRoomId, viewingArchived, closedOnScreen])

  /* -------------------------------- sending ------------------------------- */

  const postMessage = useCallback(
    async (row: ChatMessage) => {
      // A closed room is read-only by definition; the route would answer 404 and
      // the user would see a spurious failure, so the attempt is not made.
      if (!viewingRoomId || closedOnScreen) return
      try {
        const res = await apiFetch(`/api/chat/channels/${viewingRoomId}/messages`, {
          method: 'POST',
          body: JSON.stringify({
            content: row.content,
            clientId: row.clientId,
            // Only the type + id is sent. The label the picker showed is never
            // trusted back — the server re-reads the record on every render.
            references: (row.references ?? [])
              .filter((r) => r.state === 'available')
              .map((r) => ({ entityType: r.entityType, entityId: r.entityId })),
          }),
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
    [viewingRoomId, closedOnScreen]
  )

  const sendMessage = useCallback(() => {
    const text = draft.trim()
    if (!text || !viewingRoomId || closedOnScreen || !user || offline) return
    const clientId = genClientId()
    const optimistic: ChatMessage = {
      _id: '',
      tempId: clientId,
      clientId,
      channelId: viewingRoomId,
      senderId: currentUserId,
      senderName: user.name,
      content: text,
      isSystem: false,
      isDeleted: false,
      editable: true,
      createdAt: new Date().toISOString(),
      status: 'sending',
      // The chips the sender just picked are shown immediately; the POST response
      // replaces this row with the server's permission-checked version.
      references: pendingRefs.map((r) => ({ state: 'available' as const, ...r })),
    }
    setDraft('')
    setPendingRefs([])
    setMessages((prev) => [...prev, optimistic])
    void postMessage(optimistic)
  }, [draft, pendingRefs, viewingRoomId, closedOnScreen, user, offline, currentUserId, postMessage])

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
      if (!viewingRoomId || closedOnScreen) return
      try {
        const res = await apiFetch(`/api/chat/channels/${viewingRoomId}/messages/${id}`, {
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
    [viewingRoomId, closedOnScreen]
  )

  const deleteMessage = useCallback(
    async (id: string) => {
      if (!viewingRoomId || closedOnScreen) return
      try {
        const res = await apiFetch(`/api/chat/channels/${viewingRoomId}/messages/${id}`, {
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
    [viewingRoomId, closedOnScreen]
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
        // The room leaves the list because it is now archived, not because it is
        // gone: Archived Chats shows it with its full history and a restore.
        setChannels((prev) => prev.filter((c) => c._id !== id))
        setActiveId((prev) => {
          if (prev !== id) return prev
          const next = channels.find((c) => c._id !== id)
          return next?._id ?? null
        })
        setToast({
          type: 'success',
          message: 'Channel archived — find it again under Archived Chats.',
        })
      } catch (err) {
        setToast({
          type: 'error',
          message: err instanceof Error ? err.message : 'Failed to archive channel',
        })
      }
    },
    [channels]
  )

  /** Restore is the mirror of archive, and shares its shape so the two paths
   *  cannot drift: mutate, refetch the authoritative list, report the result. */
  const restoreChannel = useCallback(
    async (id: string): Promise<boolean> => {
      setRestoring(true)
      try {
        const res = await apiFetch(`/api/chat/channels/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ isArchived: false }),
        })
        const body = await readEnvelope<ChatChannel>(res)
        if (!body.success) throw new Error(body.error?.message ?? 'Failed to restore channel')
        // Refetch rather than splice: the restored row needs a fresh unread
        // count, which only the list endpoint computes.
        await loadChannels()
        // If this very room is open in the panel, it must stop being a read-only
        // archived view the moment it becomes an ordinary channel again.
        if (archivedRoom?._id === id) {
          reqSeq.current += 1
          setArchivedRoom(null)
          setMessages([])
          setMessagesError(null)
          setActiveId(id)
        }
        setToast({
          type: 'success',
          message: `Restored #${body.data?.name ?? 'channel'} to the channel list`,
        })
        return true
      } catch (err) {
        setToast({
          type: 'error',
          message: err instanceof Error ? err.message : 'Failed to restore channel',
        })
        return false
      } finally {
        setRestoring(false)
      }
    },
    [loadChannels, archivedRoom]
  )

  /* ------------------------------- references ----------------------------- */

  const addReference = useCallback((candidate: ReferenceCandidate) => {
    setPendingRefs((prev) =>
      prev.some((r) => referenceKey(r) === referenceKey(candidate)) ? prev : [...prev, candidate]
    )
  }, [])

  const removeReference = useCallback((key: string) => {
    setPendingRefs((prev) => prev.filter((r) => referenceKey(r) !== key))
  }, [])

  const openArchivedRoom = useCallback((channel: ChatChannel) => {
    setArchivedListOpen(false)
    setSidebarOpen(false)
    setActiveId(null)
    setArchivedRoom(channel)
  }, [])

  const closeArchivedRoom = useCallback(() => {
    // `++reqSeq` abandons any in-flight archived fetch so it cannot land on top
    // of the channel this view is switching back to.
    reqSeq.current += 1
    setArchivedRoom(null)
    setMessages([])
    setMessagesError(null)
    setActiveId((cur) => cur ?? channels[0]?._id ?? null)
  }, [channels])

  /* ------------------------------ lifecycle ------------------------------- */

  useEffect(() => {
    if (!user) return
    void loadChannels({ selectFirst: true })
    void loadMembers()
  }, [user, loadChannels, loadMembers])

  /* The notification's `?channel=` is a one-shot routing hint, not state: once
   * consumed it is dropped from the URL so a later refresh, or a shared link,
   * does not keep re-selecting a channel the user has since left. */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (!params.has('channel')) return
    params.delete('channel')
    const query = params.toString()
    window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname)
  }, [])

  useEffect(() => {
    if (!user || !viewingRoomId) return
    void openRoom(viewingRoomId, viewingArchived)
    // Re-open only when the room in view changes, not on every channels poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, viewingRoomId, viewingArchived])

  /* A mention notification points at `/chat?channel=<id>`. The first channel
   * load already selects it when the room is open. If it is not there — closed
   * since the message was written — a Founder is offered the archived copy, and
   * anyone else is told plainly rather than left on an unrelated channel. */
  useEffect(() => {
    const wanted = deepLinkRef.current
    if (!wanted || channelsLoading || channelsError) return
    if (channels.some((c) => c._id === wanted)) {
      deepLinkRef.current = null
      return
    }
    if (deepLinkResolvedRef.current) return
    deepLinkResolvedRef.current = true
    deepLinkRef.current = null
    if (!canManage) {
      setToast({ type: 'info', message: 'That conversation is no longer in your channel list.' })
      return
    }
    void (async () => {
      try {
        const res = await apiFetch('/api/chat/channels?archived=true')
        const body = await readEnvelope<ChatChannel[]>(res)
        const room = body.data?.find((c) => c._id === wanted)
        if (room) {
          openArchivedRoom(room)
          setToast({ type: 'info', message: `#${room.name} is archived — opening it read-only.` })
        } else {
          setToast({ type: 'info', message: 'That conversation could not be found.' })
        }
      } catch {
        /* the default channel is already on screen; a failed lookup needs no noise */
      }
    })()
  }, [channels, channelsLoading, channelsError, canManage, openArchivedRoom])

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

  const canModify = useCallback(
    (m: ChatMessage) => Boolean(m.editable) && !closedOnScreen,
    [closedOnScreen]
  )
  const sendingDisabled =
    !viewingRoomId || closedOnScreen || offline || !user || connState === 'offline'
  const displayChannel = archivedRoom ?? activeChannel ?? retainedChannel

  const rail = (
    <ChannelSidebar
      channels={channels}
      activeId={activeId}
      loading={channelsLoading}
      canManage={canManage}
      viewingArchived={viewingArchived}
      onSelect={(id) => {
        // Leaving the archived view is a navigation, and it must abandon any
        // in-flight archived fetch the same way `closeArchivedRoom` does.
        if (archivedRoom) {
          reqSeq.current += 1
          setArchivedRoom(null)
          setMessages([])
          setMessagesError(null)
        }
        setActiveId(id)
        setSidebarOpen(false)
      }}
      onCreate={createChannel}
      onArchive={archiveChannel}
      onOpenArchived={() => setArchivedListOpen(true)}
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
              <h1 className="flex items-center gap-2 truncate text-sm font-semibold text-ink">
                <span className="truncate">
                  {displayChannel ? `#${displayChannel.name}` : 'Team Chat'}
                </span>
                {closedOnScreen && <Badge size="sm">Archived</Badge>}
              </h1>
              {displayChannel?.description && (
                <p className="truncate text-xs text-ink-muted">{displayChannel.description}</p>
              )}
            </div>
            {viewingArchived && (
              <button
                type="button"
                onClick={closeArchivedRoom}
                aria-label="Close archived channel"
                className="inline-flex h-11 w-11 items-center justify-center rounded-md text-ink-secondary hover:bg-surface-sunken"
              >
                <IconClose className="h-5 w-5" />
              </button>
            )}
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
          ) : !viewingRoomId ? (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-ink-muted">
              {channelsLoading
                ? 'Loading channels…'
                : 'No channels yet. Ask the Founder to create one.'}
            </div>
          ) : (
            <>
              {closedOnScreen && (
                /* Read-only, stated once, with the way out next to it. The history
                   above is complete — the room is closed, not deleted. A Founder can
                   restore from here; anyone else is told who can, because restoring
                   is not their verb. */
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line-subtle bg-status-info-bg px-3 py-2">
                  <p className="min-w-0 flex-1 text-xs text-status-info">
                    {viewingArchived
                      ? 'This channel is archived. Its previous messages are preserved, but it no longer accepts new ones.'
                      : 'This channel was archived while you were reading it. Its messages are preserved and nothing was deleted.'}
                  </p>
                  {canManage && (
                    <Button
                      size="sm"
                      variant="outline"
                      loading={restoring}
                      onClick={() => void restoreChannel(viewingRoomId!)}
                    >
                      {!restoring && <IconRefresh className="mr-1 h-4 w-4" />}
                      Restore channel
                    </Button>
                  )}
                </div>
              )}

              {messagesError ? (
                <div className="p-4">
                  <ErrorState
                    title="Could not load messages"
                    description={messagesError}
                    action={{
                      label: 'Try again',
                      onClick: () => void openRoom(viewingRoomId, viewingArchived),
                    }}
                  />
                </div>
              ) : (
                <MessageList
                  messages={messages}
                  currentUserId={currentUserId}
                  loading={messagesLoading}
                  /* A room closed on another device has no readable older page: the
                     archived path is Founder-only, so the control is hidden rather
                     than offered and then failing. */
                  hasMoreOlder={hasMoreOlder && !(activeVanished && !canManage)}
                  loadingOlder={loadingOlder}
                  onLoadOlder={() => void loadOlder()}
                  canModify={canModify}
                  onEdit={editMessage}
                  onDelete={deleteMessage}
                  onRetry={(row) => retryMessage(row)}
                />
              )}

              {closedOnScreen ? (
                <div className="border-t border-line-subtle px-3 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
                  <p className="flex items-center gap-2 text-xs text-ink-muted">
                    <IconArchive className="h-4 w-4 shrink-0" />
                    {viewingArchived
                      ? 'Archived channel — restore it to post here.'
                      : 'Archived channel — the Founder can restore it to post here.'}
                  </p>
                </div>
              ) : (
                <div className="border-t border-line-subtle p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
                  <Composer
                    value={draft}
                    onChange={setDraft}
                    onSend={sendMessage}
                    disabled={sendingDisabled}
                    members={members}
                    references={pendingRefs}
                    onAddReference={addReference}
                    onRemoveReference={removeReference}
                  />
                </div>
              )}
            </>
          )}
        </section>
      </div>

      <ArchivedChatsModal
        isOpen={archivedListOpen}
        onClose={() => setArchivedListOpen(false)}
        onOpenRoom={openArchivedRoom}
        onRestore={restoreChannel}
      />
    </PageTransition>
  )
}
