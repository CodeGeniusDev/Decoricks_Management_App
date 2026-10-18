/**
 * Shared notification wiring for a NEW finance ledger entry (design §6.4/6).
 *
 * The transactions route and the offline sync route both call THIS, so an
 * offline create fires exactly the same alerts as the same create done
 * online — large-expense threshold, withdrawal request, budget crossings —
 * with the same swallowing rule: a notification must NEVER turn a saved entry
 * into a failed request. Awaited so alerts are durable before the client sees
 * success (the bell and the tests both rely on it).
 */

import type { Db } from 'mongodb'
import type { LedgerTransaction } from '@/lib/models/Ledger'
import {
  maybeNotifyLargeExpense,
  notifyBudgetCrossingsForExpense,
  notifyWithdrawalRequest,
} from './events'

export const notifyFinanceEntryCreated = async (db: Db, doc: LedgerTransaction): Promise<void> => {
  if (!doc._id) return
  const txId = doc._id.toString()
  try {
    await Promise.all([
      maybeNotifyLargeExpense(db, {
        transactionId: txId,
        type: doc.type,
        amountPaisa: doc.amount,
        note: doc.note,
      }),
      doc.type === 'partner_withdrawal'
        ? notifyWithdrawalRequest(db, txId, doc.partnerName)
        : Promise.resolve(0),
      doc.type === 'expense' && doc.category
        ? notifyBudgetCrossingsForExpense(db, doc.category, doc.date)
        : Promise.resolve(0),
    ])
  } catch (notifyError) {
    console.error('finance entry notifications failed:', notifyError)
  }
}
