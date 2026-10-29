'use client'

import { useEffect, useState } from 'react'

/**
 * Browser connectivity, read once and shared.
 *
 * `navigator.onLine` plus the `online` / `offline` window events. This is the
 * app's only reader: the header pill, the dashboard chip and the offline banner
 * used to each wire the same listeners, and the disagreement between two of
 * those copies is exactly the bug this exists to prevent — the header can no
 * longer say one thing while a chip that never consulted the browser says
 * another.
 *
 * Starts `true` on purpose. The server has no idea whether this device has a
 * connection, so the first paint must match between SSR and client, and the
 * effect corrects it within a frame on a device that is genuinely offline. A
 * device that boots offline sees one frame of the default — an honest unknown
 * — rather than a hydration mismatch.
 */
export function useBrowserOnline(): boolean {
  const [online, setOnline] = useState(true)

  useEffect(() => {
    setOnline(navigator.onLine)
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  return online
}
