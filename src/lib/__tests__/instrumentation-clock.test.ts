import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { register, warnIfClockIsNotKarachi } from '@/instrumentation.node'
import { getKarachiDate } from '@/lib/date'

/*
 * The application's whole date layer assumes a process clock named
 * Asia/Karachi (`getKarachiDate()` renders Karachi wall time and re-parses it in
 * the process zone). A deployment that runs anywhere else stores every
 * timestamp shifted, and nothing about the app looks broken while it does —
 * which is exactly why the boot check exists, and exactly why it is tested here
 * rather than trusted.
 *
 * `register()` is safe to call in this suite: it returns before touching the
 * database when `NODE_ENV` is neither production nor development, so these
 * tests exercise the real boot order (pin, then check) with none of the I/O.
 */

/**
 * Whatever the host had, restored exactly — including "nothing". Leaving a
 * forced `TZ` behind would shift every later date assertion in this worker, so
 * the helper, not the cases, owns the cleanup.
 */
const previousTZ = process.env.TZ

const restoreTZ = (): void => {
  if (previousTZ === undefined) delete process.env.TZ
  else process.env.TZ = previousTZ
}

/**
 * Run `body` with `process.env.TZ` forced, then restore it.
 *
 * Async on purpose: the boot path under test *is* async, and a synchronous
 * helper would put the variable back before `register()` had run — which is how
 * a test can pass while proving nothing about the pin it means to exercise.
 */
const withTZ = async <T>(zone: string | undefined, body: () => T | Promise<T>): Promise<T> => {
  // Node re-reads `process.env.TZ` on every date operation, so no module cache
  // needs resetting between these cases.
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
  try {
    return await body()
  } finally {
    restoreTZ()
  }
}

/** Hours between what the date layer would store and the true instant. */
const driftHours = (): number => (getKarachiDate().getTime() - Date.now()) / 3_600_000

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
  restoreTZ()
})

describe('boot-time Karachi clock check', () => {
  it('says nothing on a process that is already on the Karachi clock', async () => {
    await withTZ('Asia/Karachi', () => {
      expect(driftHours()).toBeLessThan(0.02)
      expect(() => warnIfClockIsNotKarachi()).not.toThrow()
      expect(warn).not.toHaveBeenCalled()
    })
  })

  it('warns when the host runs UTC, and names the fix', async () => {
    await withTZ('UTC', () => {
      expect(driftHours()).toBeCloseTo(5, 0)
      warnIfClockIsNotKarachi()
      expect(warn).toHaveBeenCalledTimes(1)
      const message = String(warn.mock.calls[0][0])
      expect(message).toContain('Asia/Karachi')
      expect(message).toContain('away from the true instant')
      // An operator reading this must be able to act without opening a file.
      expect(message).toContain('TZ=Asia/Karachi')
    })
  })

  it('warns for a zone with the right offset and the wrong name', async () => {
    /*
     * The trap that makes this check worth having: Asia/Lahore is also +05:00,
     * so an offset comparison would call that host correct. It is not —
     * `getKarachiDate()` measures five hours out there too, and this case is the
     * reason the contract is the zone identifier rather than the number.
     */
    await withTZ('Asia/Lahore', () => {
      expect(driftHours()).toBeCloseTo(5, 0)
      warnIfClockIsNotKarachi()
      expect(warn).toHaveBeenCalledTimes(1)
    })
  })

  it('pins the clock when the deployment set no TZ, and stays silent after', async () => {
    /*
     * The boot order matters: `register()` installs the zone and only then
     * checks, so a deployment that never mentions TZ is correct *and* quiet.
     * Asserting the value of `process.env.TZ` afterwards is what pins the
     * ordering — checking first would report the default it was about to fix.
     */
    await withTZ(undefined, async () => {
      expect(process.env.TZ).toBeUndefined()
      await register()
      expect(process.env.TZ).toBe('Asia/Karachi')
      expect(warn).not.toHaveBeenCalled()
    })
  })

  it('never overrides an explicit TZ — it only reports the consequence', async () => {
    /*
     * Deliberate: a test runner (and the Playwright gate) pins `TZ=UTC` on
     * purpose. The boot check informs instead of fighting that choice, which is
     * what makes it safe to have in a production path at all. Asserted through
     * `register()` itself, because that is the function that decides.
     */
    await withTZ('UTC', async () => {
      await register()
      expect(process.env.TZ).toBe('UTC')
      expect(warn).toHaveBeenCalledTimes(1)
    })
  })
})
