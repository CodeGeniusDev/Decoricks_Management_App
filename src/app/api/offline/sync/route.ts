import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { ObjectId } from 'mongodb'
import { handleRouteError, withAuth, getRequestMeta, HttpError } from '@/lib/http'
import { authorize, requireAuth, AuthorizationError } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { validationError } from '@/lib/api-response'
import { recordAuditEntry } from '@/lib/audit'
import { ledgerEntrySchema } from '@/lib/schemas/finance'
import { budgetSchema } from '@/lib/schemas/operations'
import {
  buildSerializeContext,
  createLedgerEntry,
  loadAccounts,
  loadCategories,
  serializeEntry,
} from '@/lib/finance-ledger'
import { createBudget } from '@/lib/budget-create'
import { budgetToJSON } from '@/lib/models/Operations'
import { notifyFinanceEntryCreated } from '@/lib/notifications/wiring'
import { notifySyncConflict } from '@/lib/notifications/events'

/**
 * POST /api/offline/sync — the ONE server door for a queued offline create
 * (design §6.4: re-check everything, trust nothing).
 *
 * The body is a single operation; drains are sequential client-side (D3), so
 * ordering inside an entity is preserved without batch plumbing. The route:
 *
 *  1. re-authenticates (session cookie)                     → 401 UNAUTHENTICATED
 *  2. re-checks CURRENT permission (revoked while offline)  → 403 FORBIDDEN
 *  3. re-validates with the SAME zod schemas the online forms use → 400
 *  4. DELEGATES to the existing write engines (createLedgerEntry /
 *     createBudget) — idempotency, accounts/categories checks, the
 *     withdrawal lock all come along; nothing is reimplemented here
 *  5. tags an `offline_sync_applied` audit row with the originating key
 *  6. replays the online notification wiring for genuinely new entries
 *
 * A 409 (withdrawal lock) or 403 (revoked) additionally fires `sync_conflict`
 * to the owner and the Founder (§7) — the server knows a conflict happened,
 * so the alert does not depend on the client surviving to report it.
 */

/** One queued operation. The key is the ledger's dedup arbiter (D2/D3). */
const syncRequestSchema = z.object({
  id: z.string().min(8).max(120, 'Queue id is malformed'),
  idempotencyKey: z.string().min(8).max(120),
  operation: z.enum(['create_finance', 'create_budget']),
  payload: z.record(z.unknown()),
})

async function __POST(request: NextRequest) {
  // Parsed outside the delegating try so a malformed envelope is a plain 400
  // and never reaches (or pollutes) the write engines.
  const envelope = syncRequestSchema.safeParse(await request.json().catch(() => null))
  if (!envelope.success) {
    return validationError(
      'Malformed sync request',
      envelope.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
    )
  }
  const { operation, idempotencyKey, payload } = envelope.data

  try {
    const db = await getDatabase()

    // 2. CURRENT permission — what was allowed when the form was filled may
    // not be allowed now; the queue never overrides a role change (§7).
    // One authorize call: the result doubles as the actor source below.
    const permission =
      operation === 'create_finance'
        ? {
            module: 'finance' as const,
            action:
              (payload as { type?: unknown }).type === 'partner_withdrawal' ? 'approve' : 'create',
          }
        : { module: 'budget' as const, action: 'create' as const }
    const auth = await authorize(permission.module, permission.action)

    const meta = await getRequestMeta()
    const actor = {
      id: auth.user._id as ObjectId,
      name: auth.user.name,
      email: auth.user.email,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    }

    // 3/4. Validate with the online schema, then delegate. The envelope's key
    // overrides any copy inside the payload: exactly one arbiter (D3).
    if (operation === 'create_finance') {
      const parsed = ledgerEntrySchema.safeParse({ ...payload, idempotencyKey })
      if (!parsed.success) {
        throw new HttpError(
          'Validation failed',
          400,
          'VALIDATION_ERROR',
          parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
        )
      }

      const { doc, created } = await createLedgerEntry(db, parsed.data, actor)

      // 5. Audit trail of the SYNC ACT itself (the create path already audited
      // the entry) — links the ledger row to the queue entry that produced it.
      await recordAuditEntry(db, {
        userId: actor.id,
        userEmail: actor.email,
        action: 'offline_sync_applied',
        entityType: 'finance',
        entityId: doc._id ?? null,
        newValue: { idempotencyKey, offline: true, replayed: !created },
        details: `Offline queue entry ${created ? 'created' : 'replayed'} (key ${idempotencyKey})`,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      })

      // 6. Same alerts as the online POST, only for a genuinely new row.
      if (created && doc._id) await notifyFinanceEntryCreated(db, doc)

      const [accounts, categories] = await Promise.all([loadAccounts(db), loadCategories(db)])
      const ctx = buildSerializeContext(accounts, categories)
      return NextResponse.json(
        {
          success: true,
          data: { created, entry: serializeEntry(doc, ctx) },
          timestamp: new Date().toISOString(),
        },
        { status: created ? 201 : 200 }
      )
    }

    const parsed = budgetSchema.safeParse({ ...payload, idempotencyKey })
    if (!parsed.success) {
      throw new HttpError(
        'Validation failed',
        400,
        'VALIDATION_ERROR',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const { budget, created } = await createBudget(db, parsed.data, actor)

    await recordAuditEntry(db, {
      userId: actor.id,
      userEmail: actor.email,
      action: 'offline_sync_applied',
      entityType: 'budget',
      entityId: budget._id ?? null,
      newValue: { idempotencyKey, offline: true, replayed: !created },
      details: `Offline queue budget ${created ? 'created' : 'replayed'} (key ${idempotencyKey})`,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return NextResponse.json(
      {
        success: true,
        data: { created, budget: budgetToJSON(budget) },
        timestamp: new Date().toISOString(),
      },
      { status: created ? 201 : 200 }
    )
  } catch (error) {
    // §7: a queued create that hits 403/409 is a CONFLICT the Founder must
    // see even if the owner's device never comes back. Best-effort; the
    // dedupe key inside makes retries of the same conflict silent.
    // AuthorizationError is NOT an HttpError subclass, so it is matched too.
    const isConflict =
      error instanceof AuthorizationError ||
      (error instanceof HttpError && (error.status === 403 || error.status === 409))
    if (isConflict) {
      try {
        const db = await getDatabase()
        // The 403/409 paths all imply a valid session (withAuth already ran),
        // so requireAuth here cannot realistically throw — the wrapped try
        // keeps alert plumbing from ever masking the real error response.
        const auth = await requireAuth()
        await notifySyncConflict(db, {
          userId: (auth.user._id as ObjectId).toString(),
          idempotencyKey,
          reason: error.message,
        })
      } catch {
        // Conflict alerts must never mask the real error response.
      }
    }
    return handleRouteError(error)
  }
}

export const POST = withAuth(__POST)
