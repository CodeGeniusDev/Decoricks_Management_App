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
  const [inputValue, setInputValue] = useState('')
  const [sending, setSending] = useState(false)
  const [toastMessage, setToastMessage] = useState<{
    type: 'success' | 'error' | 'info' | 'warning'
    message: string
  } | null>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

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
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load messages')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchMessages()
  }, [fetchMessages])

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
      <h1 className="text-2xl font-bold text-decoricks-dark mb-6">Team Chat</h1>

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
