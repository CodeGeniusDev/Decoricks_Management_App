import { withAuth } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/mongodb'
import { getIncomeCollection, getExpenseCollection, getTransferCollection } from '@/lib/models/Finance'
import { getStartOfMonth, getEndOfMonth } from '@/lib/date'
import { formatPaisa, pkrToPaisa } from '@/lib/money'

async function __GET(request: NextRequest) {
  try {
    await authorize('finance', 'view')

    const db = await getDatabase()
    const now = getStartOfMonth()
    const monthStart = getStartOfMonth()
    const monthEnd = getEndOfMonth()

    const incomeCol = getIncomeCollection(db)
    const expenseCol = getExpenseCollection(db)
    const transferCol = getTransferCollection(db)

    // MTD Income
    const incomeAgg = await incomeCol
      .aggregate([
        { $match: { date: { $gte: monthStart, $lte: monthEnd } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ])
      .toArray()
    const mtdIncome = incomeAgg[0]?.total || 0

    // MTD Expenses
    const expenseAgg = await expenseCol
      .aggregate([
        { $match: { date: { $gte: monthStart, $lte: monthEnd } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ])
      .toArray()
    const mtdExpenses = expenseAgg[0]?.total || 0

    // MTD Transfers
    const transferAgg = await transferCol
      .aggregate([
        { $match: { date: { $gte: monthStart, $lte: monthEnd } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ])
      .toArray()
    const mtdTransfers = transferAgg[0]?.total || 0

    const netCashFlow = mtdIncome - mtdExpenses

    // Recent entries (last 10)
    const recentIncome = await incomeCol.find({}).sort({ date: -1 }).limit(5).toArray()
    const recentExpenses = await expenseCol.find({}).sort({ date: -1 }).limit(5).toArray()

    return NextResponse.json({
      success: true,
      data: {
        mtdIncome,
        mtdIncomeDisplay: formatPaisa(mtdIncome),
        mtdExpenses,
        mtdExpensesDisplay: formatPaisa(mtdExpenses),
        mtdTransfers,
        netCashFlow,
        netCashFlowDisplay: formatPaisa(netCashFlow),
        recentIncome: recentIncome.map((i) => ({
          _id: i._id?.toString(),
          incomeNumber: i.incomeNumber,
          amount: i.amount,
          amountDisplay: formatPaisa(i.amount),
          category: i.category,
          source: i.source,
          description: i.description,
          date: i.date,
          createdAt: i.createdAt,
        })),
        recentExpenses: recentExpenses.map((e) => ({
          _id: e._id?.toString(),
          expenseNumber: e.expenseNumber,
          amount: e.amount,
          amountDisplay: formatPaisa(e.amount),
          category: e.category,
          description: e.description,
          date: e.date,
          createdAt: e.createdAt,
        })),
        timestamp: new Date().toISOString(),
      },
    })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: { message: error instanceof Error ? error.message : 'Internal server error' },
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    )
  }
}

export const GET = withAuth(__GET)
