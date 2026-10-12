import { NextResponse } from 'next/server'

/**
 * One CSV download response, built the same way for every export.
 *
 * The Phase 3 ledger export set the pattern: `text/csv`, an `attachment` filename
 * carrying the date it was produced, and `no-store` so a browser cannot show a
 * yesterday's file when the user asks for today's numbers. Repeating those
 * headers per route is how one export ends up cacheable while the other is not.
 *
 * Money leaves as a decimal PKR figure (never a paisa integer), matching every
 * other CSV in the app — a partner opening the file in Excel should not have to
 * know the internal scale to read an amount.
 */
export function csvResponse(csv: string, prefix: string): NextResponse {
  const filename = `decoricks-${prefix}-${new Date().toISOString().slice(0, 10)}.csv`
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}
