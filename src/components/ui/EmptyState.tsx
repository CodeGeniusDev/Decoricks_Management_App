'use client'

import React from 'react'
import { IconInbox } from './icons'
import { Button } from './Button'

interface EmptyStateProps {
  title: string
  description?: string
  action?: {
    label: string
    onClick: () => void
  }
  icon?: React.ReactNode
}

/**
 * EmptyState — compact, left-aligned placeholder shown inside a panel.
 *
 * Previously a 64px glyph centred in `py-12`, which reserved a huge block of
 * vertical space for one sentence and made short pages look empty. It now sits
 * inline within the surface that owns it, so the surrounding table/list framing
 * stays visible and the eye is not dragged to the middle of the viewport.
 */
export const EmptyState = ({ title, description, action, icon }: EmptyStateProps) => (
  <div className="flex flex-col items-center gap-2 px-4 py-10 text-center sm:py-12">
    <span className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-surface-sunken text-ink-muted">
      {icon ?? <IconInbox size={20} />}
    </span>
    <h3 className="text-sm font-semibold text-decoricks-dark">{title}</h3>
    {description && <p className="max-w-xs text-sm text-ink-muted">{description}</p>}
    {action && (
      <div className="mt-2">
        <Button variant="primary" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      </div>
    )}
  </div>
)