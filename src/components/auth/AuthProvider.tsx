'use client'

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import type { PermissionSet } from '@/lib/models/User'
import { setLivePermissions } from '@/lib/permissions-client'
import { purgePageCaches } from '@/lib/push/register-service-worker'

/**
 * Client-side session state.
 *
 * Single source of truth for the current user. Guards read from here but do NOT
 * push the browser around on their own — the component that initiated the
 * transition (login/password change) owns the navigation to avoid races.
 *
 * The session is validated against `GET /api/auth/me` on every mount. It is
 * deliberately *not* seeded from `localStorage`: a cached user rendered before
 * the cookie is checked is how the UI could claim a session the server had
 * already rejected (every subsequent API call answered 401). `loading` stays
 * true until the server has answered, so no authenticated screen renders on a
 * stale cache.
 *
 * The provider value is memoised on a *stable* `refresh` identity so the
 * context never changes shape between renders. `refresh` is built once in a
 * module-level closure (not a useCallback) and memoised with `useMemo` — this
 * is the fix for the `Fast Refresh had to perform a full reload` cycle: an
 * inline arrow function in the context value would change on every render, and
 * a `useState`/`useReducer` consumer that reads a new function reference every
 * tick would re-render the whole tree, recompile the client bundle, and spin
 * `next dev`'s HMR in a tight loop. A module-level function is safe to call and
 * to store in context, and the context value never changes unless real state
 * (user/loading/error) does.
 */

export interface SessionUser {
  _id?: string
  email: string
  name: string
  role: string
  partnerId?: string
  isActive: boolean
  mustChangePassword: boolean
  /**
   * The caller's effective permission matrix, read from the authoritative roles
   * collection by `/api/auth/me` and `/api/auth/login`. Optional: a nav check
   * without it falls back to the SPEC defaults, so a stale or absent copy never
   * silently changes what the server enforces (which is always server-side).
   */
  permissions?: PermissionSet
  /**
   * Where the member's own profile picture is served from, derived server-side
   * from the reference persisted on their user document. Absent until they upload
   * one — which is what every avatar in the app reads as "show the initial".
   *
   * It arrives with the session rather than being fetched per screen, so a
   * picture shows up in the header and on the profile page from the same read
   * that decides whether the visitor is signed in at all.
   */
  avatarUrl?: string
}

interface AuthContextValue {
  user: SessionUser | null
  loading: boolean
  /**
   * The session could not be determined. Deliberately separate from
   * `user === null`, which means the server *said* there is no session.
   *
   * Without this the two are indistinguishable to the guard, so a transaction
   * that never answered (database blip, 5xx, a dev-server recompile outliving the
   * request) reads as "signed out" and bounces a validly authenticated user to
   * `/login`. The 401-only rule below protects the session; this protects the
   * redirect, which is the half the user actually feels.
   */
  error: boolean
  mustChangePassword: boolean
  signIn: (email: string, password: string) => Promise<SessionUser>
  signOut: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

// Module-level closure — stable identity, safe to store in the context value
// and never changes shape between renders. This is the key fix for the Fast
// Refresh full-reload cycle: if the context value changed on every render,
// the whole client tree would re-render, the client bundle would recompile,
// and `next dev` HMR would spin in a tight loop.
const refreshFn = async (
  applyUser: (next: SessionUser | null) => void,
  setError: (v: boolean) => void,
  setLoading: (v: boolean) => void
) => {
  try {
    const res = await fetch('/api/auth/me', {
      cache: 'no-store',
      credentials: 'same-origin',
    })

    // Only an explicit auth rejection clears the session. A transient 5xx
    // (for example the database being briefly unavailable) must not sign the
    // user out — that would turn a blip into a logout.
    if (res.status === 401 || res.status === 403) {
      applyUser(null)
      return
    }
    // Anything else that is not a session answer: the state is unknown, not
    // empty. `error` keeps the guard from redirecting; `finally` still clears
    // `loading` so the UI is never stuck on a skeleton with no explanation.
    if (!res.ok) {
      setError(true)
      return
    }

    const body = await res.json().catch(() => null)
    const user = body?.data?.user as SessionUser | undefined
    // Merge the authoritative permissions returned alongside the user so the
    // shell reflects the live role matrix, not just the hardcoded defaults.
    applyUser(user ? { ...user, permissions: body?.data?.permissions } : null)
  } catch {
    // Network failure: keep whatever the last verified state was, and mark the
    // session undetermined rather than absent.
    setError(true)
  } finally {
    setLoading(false)
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const applyUser = useCallback((next: SessionUser | null) => {
    setUser(next)
    // A deliberate session answer (signed in, signed out, or a real 401) always
    // supersedes an earlier "could not tell", so the flag is cleared here rather
    // than at each call site.
    setError(false)
    // Keep the module-level display cache in step with the session so every
    // `can()` / nav check reads the authoritative matrix returned by the API.
    // Signing out (next = null) clears it, so a subsequent session never reuses
    // a stale grant. This is display state only; the server re-checks per request.
    setLivePermissions(next?.permissions ?? null)
  }, [])

  // Stable identity for context — built once, never recreated per render.
  const refresh = useMemo(() => () => refreshFn(applyUser, setError, setLoading), [applyUser])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const signIn = useCallback(
    async (email: string, password: string) => {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        credentials: 'same-origin',
      })
      const body = await res.json().catch(() => null)

      if (!res.ok) {
        throw new Error(body?.error?.message ?? 'Invalid email or password')
      }

      const loggedInUser = (body?.data?.user ?? null) as SessionUser | null
      if (!loggedInUser) throw new Error('Login failed')
      applyUser({ ...loggedInUser, permissions: body?.data?.permissions })
      return loggedInUser
    },
    [applyUser]
  )

  const signOut = useCallback(async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' })
    } finally {
      // The service worker holds cached copies of the screens this account
      // visited. Ask it to drop the documents (nothing else) before the
      // document hand-off below, so a second account on the same machine never
      // gets a snapshot of the first one's navigation history.
      void purgePageCaches()
      applyUser(null)
    }
  }, [applyUser])

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      error,
      mustChangePassword: Boolean(user?.mustChangePassword),
      signIn,
      signOut,
      refresh,
    }),
    [user, loading, error, signIn, signOut, refresh]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
