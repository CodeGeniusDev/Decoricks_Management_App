'use client'

import { useRef } from 'react'
import { Button } from '@/components/ui/Button'
import type { KeyboardEvent } from 'react'

interface ComposerProps {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  disabled: boolean
  placeholder?: string
}

/**
 * Message input.
 *
 * Deliberately a controlled textarea whose value is owned by the *page*, not
 * here, so a draft survives an offline period and a channel switch: the brief
 * requires the text to be kept when sending is disabled. Enter sends; Shift+
 * Enter inserts a newline, matching the mental model from the other partner
 * tools. The send button clears the 44px touch-target minimum.
 */
export function Composer({ value, onChange, onSend, disabled, placeholder }: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null)

  const submit = () => {
    if (disabled || !value.trim()) return
    onSend()
    if (ref.current) ref.current.style.height = 'auto'
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  return (
    <div className="flex items-end gap-2">
      <textarea
        ref={ref}
        rows={1}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          autoGrow(e.target)
        }}
        onKeyDown={onKey}
        disabled={disabled}
        placeholder={disabled ? 'Reconnecting…' : (placeholder ?? 'Type a message…')}
        aria-label="Message"
        className="min-h-[44px] flex-1 resize-none rounded-lg border border-line bg-surface-raised px-3 py-2.5 text-sm text-ink placeholder:text-ink-muted focus:border-decoricks-brown focus:outline-none disabled:opacity-60"
      />
      <Button
        type="button"
        variant="primary"
        onClick={submit}
        disabled={disabled || !value.trim()}
        className="h-11 min-w-[44px] px-4"
      >
        Send
      </Button>
    </div>
  )
}
