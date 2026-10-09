'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'

/**
 * Root error boundary.
 *
 * Individual pages surface their own load failures inline, so this catches
 * render-time crashes. `reset()` re-renders the segment without a full document
 * reload, keeping the sidebar and header state intact.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('Unhandled route error:', error)
  }, [error])

  return (
    <div className="max-w-2xl mx-auto py-12">
      <Card variant="default" className="p-8">
        <h1 className="text-xl font-bold text-decoricks-dark mb-2">Something went wrong</h1>
        <p className="text-sm text-decoricks-dark/60 mb-6">
          This page could not be displayed. Your data has not been changed.
        </p>

        {error.digest && (
          <p className="text-xs font-mono text-decoricks-dark/40 mb-6">Reference: {error.digest}</p>
        )}

        <div className="flex gap-2">
          <Button variant="primary" onClick={reset} type="button">
            Try again
          </Button>
          <Button variant="outline" href="/">
            Go to dashboard
          </Button>
        </div>
      </Card>
    </div>
  )
}