'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { PageTransition } from '@/components/PageTransition'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { Toast } from '@/components/ui/Toast'
import { apiFetch } from '@/lib/api-client'
import { useAuth } from '@/components/auth/AuthProvider'

interface Message {
  _id: string
  senderId: string
  senderName: string
  content: string
  isSystem: boolean
  createdAt: string
}

const initials = (name: string) => name.trim().charAt(0).toUpperCase() || '?'

/** How often to ask the server for messages newer than what's on screen. */
const POLL_INTERVAL_MS = 8000

export default function ChatPage() {
  // Identity comes from the verified session; the server derives the stored
  // sender itself and ignores anything the client sends.
  const { user } = useAuth()
  const currentUserId = user?._id ?? ''
  const currentUserName = user?.name ?? ''
  const identityConfigured = Boolean(user?._id)
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  // A failed background poll must not wipe the conversation or show the
  // full-page error card — that reads as "chat is broken" when it's really
  // just a hiccup. This flag only dims the "Live" indicator until the next
  // poll succeeds.
  const [pollFailing, setPollFailing] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const [sending, setSending] = useState(false)
  const [toastMessage, setToastMessage] = useState<{
    type: 'success' | 'error' | 'info' | 'warning'
    message: string
  } | null>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // High-water mark for incremental polling — only messages created after
  // this timestamp are fetched on subsequent requests, so the client never
  // re-downloads the whole history every few seconds.
  const lastSeenAtRef = useRef<number>(0)

  const mergeMessages = useCallback((incoming: Message[]) => {
    if (incoming.length === 0) return
    setMessages((prev) => {
      // The optimistic append in sendMessage() can race a poll that already
      // fetched the same document; dedupe by id so nothing ever shows twice.
      const seen = new Set(prev.map((m) => m._id))
      const fresh = incoming.filter((m) => !seen.has(m._id))
      if (fresh.length === 0) return prev
      return [...prev, ...fresh]
    })
    const newest = incoming[incoming.length - 1]
    const newestTime = new Date(newest.createdAt).getTime()
    if (newestTime > lastSeenAtRef.current) lastSeenAtRef.current = newestTime
  }, [])

  const fetchMessages = useCallback(async () => {
    try {
      setLoading(true)
      setLoadError(null)
      const res = await apiFetch('/api/chat')
      const body = await res.json()
      if (!res.ok || !body.success) {
        throw new Error(body?.error?.message || 'Failed to load messages')
      }
      setMessages(body.data)
      const newest = body.data.length ? new Date(body.data[body.data.length - 1].createdAt).getTime() : 0
      lastSeenAtRef.current = newest
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load messages')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchMessages()
  }, [fetchMessages])

  // Poll for messages from other team members. Without this the chat only
  // ever shows what existed at page load plus whatever *this* client sent —
  // a real gap, since the API already supports an incremental `since`
  // query for exactly this purpose.
  useEffect(() => {
    if (loadError) return // initial load failed; don't hammer a broken endpoint

    let cancelled = false

    const poll = async () => {
      // A hidden tab doesn't need fresh messages rendered; skip the request
      // and catch up on the next tick (or immediately on visibility, below).
      if (document.hidden) return
      try {
        const url = lastSeenAtRef.current
          ? `/api/chat?since=${lastSeenAtRef.current}`
          : '/api/chat'
        const res = await apiFetch(url)
        const body = await res.json()
        if (cancelled) return
        if (!res.ok || !body.success) throw new Error(body?.error?.message || 'Poll failed')
        setPollFailing(false)
        mergeMessages(body.data as Message[])
      } catch {
        if (!cancelled) setPollFailing(true)
      }
    }

    const interval = setInterval(poll, POLL_INTERVAL_MS)

    const onVisible = () => {
      if (!document.hidden) poll()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [loadError, mergeMessages])

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const formatTime = (dateStr: string): string => {
    const date = new Date(dateStr)
    return date.toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' })
  }

  const sendMessage = async () => {
    if (!inputValue.trim() || sending) return

    const messageText = inputValue.trim()
    setInputValue('') // Clear input immediately - optimistic
    setSending(true)

    try {
      const res = await apiFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: messageText }),
      })

      const result = await res.json()

      if (result.success) {
        // Use the persisted document so the id matches what is stored.
        setMessages((prev) => [...prev, result.data as Message])
      } else {
        // Rollback - restore input value
        setInputValue(messageText)
        setToastMessage({ type: 'error', message: result.error?.message || 'Failed to send message' })
      }
    } catch (err) {
      // Rollback on network error
      setInputValue(messageText)
      setToastMessage({
        type: 'error',
        message: 'Network error. Message not sent. Check your connection.',
      })
    } finally {
      setSending(false)
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  if (loading) {
    return (
      <PageTransition>
        <h1 className="text-2xl font-bold text-decoricks-dark mb-6">Chat</h1>
        <div className="space-y-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} variant="rect" className="h-12 w-3/4" />
          ))}
        </div>
      </PageTransition>
    )
  }

  return (
    <PageTransition>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold text-decoricks-dark">Team Chat</h1>
        {!loadError && (
          <span
            className="flex items-center gap-1.5 text-xs text-ink-muted"
            role="status"
            aria-live="polite"
          >
            <span
              className={`h-2 w-2 rounded-full ${
                pollFailing ? 'bg-status-warning' : 'bg-status-success'
              }`}
              aria-hidden
            />
            {pollFailing ? 'Reconnecting…' : 'Live'}
          </span>
        )}
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
              <h2 className="font-semibold text-decoricks-dark">Could not load messages</h2>
              <p className="text-sm text-decoricks-dark/60">{loadError}</p>
            </div>
            <Button variant="outline" onClick={fetchMessages} type="button">
              Try again
            </Button>
          </div>
        </Card>
      )}

      <Card className="h-[600px] flex flex-col">
        {/* Messages area */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
          {messages.length === 0 ? (
            <EmptyState
              title="No messages yet"
              description="Start the conversation. Messages are saved to the database."
              action={{ label: 'Focus input', onClick: () => inputRef.current?.focus() }}
            />
          ) : (
            messages.map((message) => (
              <div
                key={message._id}
                className={`flex gap-3 ${
                  message.senderId === currentUserId ? 'justify-end' : 'justify-start'
                }`}
              >
                {!message.isSystem && message.senderId !== currentUserId && (
                  <div className="w-8 h-8 rounded-full bg-decoricks-brown text-decoricks-light flex items-center justify-center text-sm font-semibold flex-shrink-0">
                    {initials(message.senderName)}
                  </div>
                )}

                <div
                  className={`max-w-[70%] px-4 py-3 rounded-lg ${
                    message.isSystem
                      ? 'bg-decoricks-dark/10 text-decoricks-dark/60 text-sm self-start'
                      : message.senderId === currentUserId
                      ? 'bg-decoricks-brown text-decoricks-light'
                      : 'border border-line-subtle bg-surface-sunken text-ink-secondary'
                  }`}
                >
                  {!message.isSystem && message.senderId !== currentUserId && (
                    <p className="text-xs font-semibold mb-1 opacity-80">
                      {message.senderName}
                    </p>
                  )}
                  <p className="whitespace-pre-wrap break-words">{message.content}</p>
                  <p
                    className={`text-xs mt-1 opacity-60 ${
                      message.senderId === currentUserId
                        ? 'text-decoricks-light/60'
                        : 'text-decoricks-dark/40'
                    }`}
                  >
                    {formatTime(message.createdAt)}
                  </p>
                </div>

                {message.senderId === currentUserId && !message.isSystem && (
                  <div className="w-8 h-8 rounded-full bg-decoricks-brown text-decoricks-light flex items-center justify-center text-sm font-semibold flex-shrink-0">
                    {initials(currentUserName)}
                  </div>
                )}
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area - no page reload on form submit */}
        <div className="border-t border-decoricks-black/10 p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              sendMessage()
            }}
            className="flex gap-2 items-center"
          >
            <Input
              ref={inputRef}
              placeholder="Type a message..."
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyPress}
              disabled={sending || !identityConfigured}
              className="flex-1"
            />
            <Button
              type="submit"
              variant="primary"
              disabled={!inputValue.trim() || sending || !identityConfigured}
              loading={sending}
            >
              Send
            </Button>
          </form>
        </div>
      </Card>
    </PageTransition>
  )
}
