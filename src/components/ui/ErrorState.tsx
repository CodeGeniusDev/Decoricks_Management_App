'use client'

import React from 'react'
import { IconAlert } from './icons'
import { Button } from './Button'

interface ErrorStateProps {
  title: string
  description?: string
  action?: {
    label: string
    onClick: () => void
  }
}

/**
 * ErrorState — compact, left-aligned failure placeholder.
 *
 * Uses the muted `danger` token rather than a full-saturation red so an inline
 * error does not shout louder than the data it sits above. Retry is the default
 * action label because almost every caller here is a failed fetch.
 */
export const ErrorState = ({ title, description, action }: ErrorStateProps) => (
  <div
    className="flex flex-col items-center gap-2 px-4 py-10 text-center sm:py-12"
    role="alert"
  >
    <span className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-status-danger-bg text-status-danger">
      <IconAlert size={20} />
    </span>
    <h3 className="text-sm font-semibold text-decoricks-dark">{title}</h3>
    {description && <p className="max-w-xs text-sm text-ink-muted">{description}</p>}
    {action && (
      <div className="mt-2">
        <Button variant="outline" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      </div>
    )}
  </div>
)