/**
 * Phase 6 task-service unit tests.
 *
 * Covers the three things the brief calls out as needing to be exactly right
 * and nowhere else: sparse position arithmetic, completion transitions driven
 * by the board's done column, and the Karachi-midnight overdue cutoff. Runs the
 * DB-touching helpers against `helpers/mem-mongo` so `computePosition`,
 * `renumberColumnIfTight` and `createTaskNumber` are exercised for real.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { ObjectId, type Db } from 'mongodb'
import {
  POSITION_GAP,
  type Column,
  type TaskDoc,
} from '@/lib/models/Tasks'
import {
  computePosition,
  createTaskNumber,
  describeMove,
  overdueCutoffKarachiMidnight,
  positionBetween,
  renumberColumnIfTight,
  karachiDayRange,
} from '@/lib/task-service'
import { createMemDb, type MemDb } from './helpers/mem-mongo'

const COLUMN_ID = new ObjectId('507f1f77bcf86cd799439101')

const task = (over: Partial<TaskDoc> & { _id: ObjectId }): TaskDoc => ({
  taskNumber: 'TASK-202610-0001',
  boardId: new ObjectId('507f1f77bcf86cd799439100'),
  columnId: COLUMN_ID,
  position: POSITION_GAP,
  title: 't',
  assigneeIds: [],
  assigneeName: '',
  priority: 'medium',
  dueDate: null,
  labelIds: [],
  checklist: [],
  completedAt: null,
  completedBy: null,
  version: 1,
  isArchived: false,
  archivedAt: null,
  createdBy: new ObjectId('507f1f77bcf86cd799439011'),
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
} as TaskDoc)

describe('positionBetween', () => {
  it('gives a first card the standard gap', () => {
    expect(positionBetween(null, null)).toBe(POSITION_GAP)
  })
  it('halves the leading gap to prepend', () => {
    expect(positionBetween(null, 1000)).toBe(500)
  })
  it('adds a gap to append', () => {
    expect(positionBetween(1000, null)).toBe(1000 + POSITION_GAP)
  })
  it('takes the midpoint when bracketed', () => {
    expect(positionBetween(1000, 2000)).toBe(1500)
  })
})

describe('describeMove', () => {
  const actor = new ObjectId('507f1f77bcf86cd799439011')
  const col = (isDone: boolean): Column =>
    ({
      _id: new ObjectId(),
      boardId: new ObjectId(),
      name: isDone ? 'Done' : 'In Progress',
      position: 1,
      isDoneColumn: isDone,
      isArchived: false,
      createdBy: actor,
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as Column

  it('marks completion only when entering the done column', () => {
    const r = describeMove(col(false), col(true), actor)
    expect(r.activityKind).toBe('completed')
    expect(r.set.completedAt).toBeInstanceOf(Date)
    expect(r.set.completedBy).toEqual(actor)
  })
  it('reopens and clears completion fields when leaving the done column', () => {
    const r = describeMove(col(true), col(false), actor)
    expect(r.activityKind).toBe('reopened')
    expect(r.set.completedAt).toBeNull()
    expect(r.set.completedBy).toBeNull()
  })
  it('treats a done→done move as completed? No — same column flags is a plain move', () => {
    // from already done and to done: wasDone && isDone → not a transition, so
    // no completion-field change; still recorded as 'moved' by the route.
    const r = describeMove(col(true), col(true), actor)
    expect(r.activityKind).toBe('moved')
    expect(r.set).toEqual({})
  })
  it('is a plain move between two open columns', () => {
    const r = describeMove(col(false), col(false), actor)
    expect(r.activityKind).toBe('moved')
    expect(r.set).toEqual({})
  })
})

describe('overdue math (Karachi midnight)', () => {
  it('a task due today (Karachi) is not yet overdue at 23:00 Karachi', () => {
    // 23:00 Karachi = 18:00 UTC the same civil day (Karachi is UTC+5).
    const now = new Date('2026-10-13T18:00:00Z')
    const cutoff = overdueCutoffKarachiMidnight(now)
    // Today (13 Oct) Karachi is not before the start of today → not overdue.
    const dueToday = new Date('2026-10-13T17:00:00Z')
    expect(dueToday.getTime() < cutoff.getTime()).toBe(false)
  })
  it('yesterday (Karachi) is overdue', () => {
    const now = new Date('2026-10-13T06:00:00Z') // 11:00 Karachi on the 13th
    const cutoff = overdueCutoffKarachiMidnight(now)
    const yesterday = new Date('2026-10-12T20:00:00Z')
    expect(yesterday.getTime() < cutoff.getTime()).toBe(true)
  })
  it('karachiDayRange spans whole civil days', () => {
    const { start, end } = karachiDayRange('2026-10-13', '2026-10-13')
    expect(start).toEqual(new Date(Date.UTC(2026, 9, 13)))
    expect(end.getTime()).toBeGreaterThan(start.getTime())
    expect(end.getUTCHours()).toBe(23)
  })
})

describe('computePosition + renumberColumnIfTight (mem-mongo)', () => {
  let mem: MemDb
  beforeEach(() => {
    mem = createMemDb()
  })

  it('returns the standard gap for an empty column', async () => {
    const col = mem.collection('tasks')
    const pos = await computePosition(col as never, COLUMN_ID, null)
    expect(pos).toBe(POSITION_GAP)
  })

  it('prepends at half the current first position', async () => {
    const col = mem.collection('tasks')
    col.push(task({ _id: new ObjectId(), position: 1000 }))
    const pos = await computePosition(col as never, COLUMN_ID, null)
    expect(pos).toBe(500)
  })

  it('inserts after a named sibling at the midpoint to the next one', async () => {
    const col = mem.collection('tasks')
    const a = new ObjectId()
    const b = new ObjectId()
    col.push(task({ _id: a, position: 1000 }))
    col.push(task({ _id: b, position: 3000 }))
    const pos = await computePosition(col as never, COLUMN_ID, a)
    expect(pos).toBe(2000)
  })

  it('renumbers a column whose neighbours have collapsed to 1 apart', async () => {
    const col = mem.collection('tasks')
    col.push(task({ _id: new ObjectId(), position: 1000 }))
    col.push(task({ _id: new ObjectId(), position: 1001 }))
    await renumberColumnIfTight(mem.handle as unknown as Db, COLUMN_ID)
    const positions = col.docs.map((d) => d.position)
    expect(positions).toEqual([POSITION_GAP, POSITION_GAP * 2])
  })

  it('leaves a roomy column untouched', async () => {
    const col = mem.collection('tasks')
    col.push(task({ _id: new ObjectId(), position: 1000 }))
    col.push(task({ _id: new ObjectId(), position: 2000 }))
    await renumberColumnIfTight(mem.handle as unknown as Db, COLUMN_ID)
    expect(col.docs.map((d) => d.position)).toEqual([1000, 2000])
  })
})

describe('createTaskNumber', () => {
  it('starts the month at 0001 and increments the highest seen', async () => {
    const mem = createMemDb()
    const col = mem.collection('tasks')
    const now = new Date()
    const ym = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`

    const first = await createTaskNumber(col as never)
    expect(first).toBe(`TASK-${ym}-0001`)

    col.push(task({ _id: new ObjectId(), taskNumber: first }))
    const second = await createTaskNumber(col as never)
    expect(second).toBe(`TASK-${ym}-0002`)
  })
})
