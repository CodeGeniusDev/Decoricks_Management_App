'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useTransition } from 'react'

/**
 * useAppNavigation — thin wrapper around Next.js App Router navigation.
 *
 * Always performs a client-side transition (never a document navigation) and
 * exposes `isPending` so callers can show a localised loading state. Use
 * `next/link` for plain links and this hook for programmatic navigation.
 */
export const useAppNavigation = () => {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const navigate = useCallback(
    (href: string, options?: { scroll?: boolean }) => {
      startTransition(() => {
        router.push(href, { scroll: options?.scroll ?? true })
      })
    },
    [router]
  )

  const replace = useCallback(
    (href: string) => {
      startTransition(() => {
        router.replace(href)
      })
    },
    [router]
  )

  const back = useCallback(() => {
    startTransition(() => {
      router.back()
    })
  }, [router])

  return { navigate, replace, back, isPending, router }
}