import { describe, expect, it } from 'vitest'
import { SyncCoordinator } from '@/lib/sync/coordinator'
import type { SyncCursor, SyncTransport } from '@/lib/sync/types'

function makeTransport() {
  let onCursor: ((c: SyncCursor) => void) | null = null
  const t: SyncTransport = {
    start(cb) {
      onCursor = cb
    },
    stop() {},
  }
  return { t, emit: (c: SyncCursor) => onCursor?.(c) }
}

describe('sync polling delete propagation (coordinator)', () => {
  it('notifies when cursor decreases after archiving newest row', () => {
    const { t, emit } = makeTransport()
    const coord = new SyncCoordinator(() => t)
    let count = 0
    coord.subscribe('tasks', () => {
      count++
    })
    // first snapshot
    emit({ tasks: 1000 })
    count = 0
    // archive/delete newest -> max timestamp drops
    emit({ tasks: 500 })
    expect(count).toBeGreaterThan(0)
  })
})
