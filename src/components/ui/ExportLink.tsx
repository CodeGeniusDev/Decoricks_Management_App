import React from 'react'

interface ExportLinkProps {
  href: string
  children?: React.ReactNode
  className?: string
}

/**
 * A CSV download trigger.
 *
 * Deliberately a plain anchor, not `next/link` and not a button: the target is
 * an API route that answers with `Content-Disposition: attachment`, so a client
 * navigation would try to render the file as a page. It carries the current
 * filter query verbatim, which is what makes an export match the screen.
 *
 * Heights match `Button md` — 44px where tables are cards, 40px on desktop — so
 * the export sits on the same baseline as the actions beside it.
 */
export const ExportLink = ({ href, children = 'Export CSV', className = '' }: ExportLinkProps) => (
  <a
    href={href}
    className={`inline-flex h-11 min-h-[44px] items-center justify-center gap-2 whitespace-nowrap rounded-md border border-line bg-surface-raised px-3.5 text-sm font-medium text-ink-secondary transition-colors hover:bg-surface-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown md:h-10 ${className}`}
  >
    {children}
  </a>
)
