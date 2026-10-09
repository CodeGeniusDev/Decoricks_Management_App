'use client'

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { apiFetch } from '@/lib/api-client'

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
 */

export interface SessionUser {
  _id?: string
  email: string
  name: string
  role: string
  partnerId?: string
  isActive: boolean
  mustChangePassword: boolean
}

interface AuthContextValue {
  user: SessionUser | null
  loading: boolean
  mustChangePassword: boolean
  signIn: (email: string, password: string) => Promise<SessionUser>
  signOut: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [loading, setLoading] = useState(true)

  const applyUser = useCallback((next: SessionUser | null) => {
    setUser(next)
  }, [])

  const refresh = useCallback(async () => {
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
      if (!res.ok) return

      const body = await res.json().catch(() => null)
      applyUser((body?.data?.user as SessionUser | undefined) ?? null)
    } catch {
      // Network failure: keep whatever the last verified state was.
    } finally {
      setLoading(false)
    }
  }, [applyUser])

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
      applyUser(loggedInUser)
      return loggedInUser
    },
    [applyUser]
  )

  const signOut = useCallback(async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' })
    } finally {
      applyUser(null)
    }
  }, [applyUser])

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      mustChangePassword: Boolean(user?.mustChangePassword),
      signIn,
      signOut,
      refresh,
    }),
    [user, loading, signIn, signOut, refresh]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
