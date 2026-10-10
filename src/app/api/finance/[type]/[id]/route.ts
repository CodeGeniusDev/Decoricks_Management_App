import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/http'
import { authorize } from '@/lib/authorization'

/**
 * Phase 1 allowed editing and hard-deleting a financial record here. SPEC
 * §10.2.3 Test 9 forbids both — a posted record must be corrected with a linked
 * reversal so the correction is visible and auditable.
 *
 * The handlers are kept as explicit 405s rather than removed so an old client
 * gets a decisive, well-formed refusal instead of a confusing 404, and cannot
 * silently believe an edit or delete succeeded.
 */
const notPermitted = () =>
  NextResponse.json(
    {
      success: false,
      error: {
        message:
          'Financial records cannot be edited or deleted. Post a reversal entry instead.',
        code: 'METHOD_NOT_ALLOWED',
      },
      timestamp: new Date().toISOString(),
    },
    { status: 405, headers: { Allow: 'GET, POST' } }
  )

async function __PUT(_req?: any, _ctx?: any) {
  await authorize('finance', 'view')
  return notPermitted()
}

async function __DELETE(_req?: any, _ctx?: any) {
  await authorize('finance', 'view')
  return notPermitted()
}

export const PUT = withAuth(__PUT)
export const DELETE = withAuth(__DELETE)
