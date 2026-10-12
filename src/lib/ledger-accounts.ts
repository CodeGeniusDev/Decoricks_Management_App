import { ObjectId, type ClientSession, type Db } from 'mongodb'
import { HttpError } from '@/lib/http'
import { getAccountCollection, getBusinessSettingsCollection } from '@/lib/models/Ledger'

/**
 * Phase 5 flows (purchases, COD income, refunds) must post to the ledger
 * without asking the operator to pick an account on every click. Resolution
 * order is fixed here so all flows agree:
 *
 *   1. an explicit `accountId` on the request,
 *   2. the configured account in business settings
 *      (`purchasingAccountId` / `salesIncomeAccountId`),
 *   3. the oldest active account.
 *
 * Validity (exists + active) is still re-checked by `createLedgerEntry` at
 * write time; this only picks a candidate.
 */
export async function resolvePostingAccount(
  db: Db,
  requestedAccountId: string | undefined,
  settingKey: 'purchasingAccountId' | 'salesIncomeAccountId',
  session?: ClientSession
): Promise<ObjectId> {
  if (requestedAccountId) {
    if (!/^[0-9a-fA-F]{24}$/.test(requestedAccountId)) {
      throw new HttpError('Invalid account id', 400, 'VALIDATION_ERROR', [
        { path: 'accountId', message: 'Malformed id' },
      ])
    }
    return new ObjectId(requestedAccountId)
  }

  const opts = session ? { session } : {}
  const settings = await getBusinessSettingsCollection(db).findOne({ key: 'business' }, opts)
  const configured = settings?.[settingKey]
  if (configured) {
    /*
     * A configured account can be archived later. Rather than letting the flow
     * fail on an invalid account, fall through to the general fallback — the
     * settings screen and the ledger both stay honest about what exists.
     */
    const chosen = await getAccountCollection(db).findOne({ _id: configured, isActive: true }, opts)
    if (chosen?._id) return chosen._id
  }

  const fallback = await getAccountCollection(db)
    .find({ isActive: true } as never, opts)
    .sort({ createdAt: 1 })
    .limit(1)
    .toArray()

  const account = fallback[0]
  if (!account) {
    throw new HttpError('No active cash account exists. Create one in Settings first.', 400, 'NO_ACCOUNT', [
      { path: 'accountId', message: 'No active account available' },
    ])
  }
  return account._id!
}
