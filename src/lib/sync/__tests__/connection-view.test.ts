/**
 * The label gate for the reported header/chip mismatch (brief item 1b).
 *
 * The rule under test is a single sentence: **"Offline" is a browser fact, not a
 * transport fact.** Every test below is the same question asked from a different
 * direction — can some store state put red Offline on screen while the browser
 * still has a connection? — because the production symptom was exactly that: the
 * header reading `navigator.onLine` and saying "Online" in green while the
 * dashboard chip read the sync store and said "Offline" in red, on the same
 * phone, in the same second.
 */
import { describe, it, expect } from 'vitest'
import {
  connectionView,
  CONNECTING_LABEL,
  LIVE_LABEL,
  OFFLINE_LABEL,
  POLLING_LABEL,
  RECONNECTING_LABEL,
  WAKING_LABEL,
} from '@/lib/sync/connection-view'
import type { ConnectionMode, ConnectionState } from '@/lib/sync/connection'

const STATES: ConnectionState[] = ['connecting', 'live', 'reconnecting', 'offline']
const MODES: ConnectionMode[] = ['sse', 'polling']

describe('connectionView', () => {
  it('never says Offline while the browser is online, for any state or mode', () => {
    for (const state of STATES) {
      for (const mode of MODES) {
        const view = connectionView({ state, mode, online: true })
        expect(view.label, `state=${state} mode=${mode}`).not.toBe(OFFLINE_LABEL)
        expect(view.tone, `state=${state} mode=${mode}`).not.toBe('danger')
      }
    }
  })

  it('says Offline from the browser alone, in every state', () => {
    for (const state of STATES) {
      for (const mode of MODES) {
        expect(connectionView({ state, mode, online: false })).toEqual({
          label: OFFLINE_LABEL,
          tone: 'danger',
        })
      }
    }
  })

  it('names the two working delivery modes differently, which is the honest part', () => {
    // A real stream that is landing events.
    expect(connectionView({ state: 'live', mode: 'sse', online: true })).toEqual({
      label: LIVE_LABEL,
      tone: 'success',
    })
    // The automatic fallback: updates still arrive, just not instantly. Calling
    // this "Live" is what made a broken stream look fine; calling it "Offline" is
    // what made a working one look dead.
    expect(connectionView({ state: 'live', mode: 'polling', online: true })).toEqual({
      label: POLLING_LABEL,
      tone: 'success',
    })
  })

  it('describes an attempt rather than a failure while the first stream opens', () => {
    expect(connectionView({ state: 'connecting', mode: 'sse', online: true })).toEqual({
      label: CONNECTING_LABEL,
      tone: 'warning',
    })
    expect(connectionView({ state: 'reconnecting', mode: 'polling', online: true })).toEqual({
      label: RECONNECTING_LABEL,
      tone: 'warning',
    })
  })

  it('lets the data layer override the transport wording while the server wakes', () => {
    // The store can only report its own state; "the host is booting" is discovered
    // by a request. Without this the chip said "Reconnecting…" for a server that
    // had never been connected, in front of a notice that said "Server is waking
    // up" — two labels for one wait.
    expect(
      connectionView({ state: 'reconnecting', mode: 'polling', online: true, waking: true })
    ).toEqual({ label: WAKING_LABEL, tone: 'warning' })
    expect(connectionView({ state: 'live', mode: 'sse', online: true, waking: true })).toEqual({
      label: WAKING_LABEL,
      tone: 'warning',
    })
    // …and the browser still outranks it: an offline device is offline whatever
    // the read layer believes it is waiting on.
    expect(connectionView({ state: 'live', mode: 'sse', online: false, waking: true })).toEqual({
      label: OFFLINE_LABEL,
      tone: 'danger',
    })
  })
})
