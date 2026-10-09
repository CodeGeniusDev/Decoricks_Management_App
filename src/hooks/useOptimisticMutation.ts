'use client'

import { useState, useCallback } from 'react'
import { apiFetch } from '@/lib/api-client'

export interface OptimisticState<T> {
  data: T | null
  pending: boolean
  error: string | null
}

export function useOptimisticMutation<T>(
  endpoint: string,
  method: 'POST' | 'PUT' | 'DELETE' = 'POST'
) {
  const [state, setState] = useState<OptimisticState<T>>({
    data: null,
    pending: false,
    error: null,
  })

  const mutate = useCallback(
    async (
      body: unknown,
      optimisticData?: T,
      onSuccess?: (result: T) => void,
      onError?: (error: Error) => void
    ) => {
      const prevData = state.data
      const prevError = state.error

      // Set optimistic state
      setState({
        data: optimisticData !== undefined ? optimisticData : prevData,
        pending: true,
        error: null,
      })

      try {
        const url = endpoint
        const res = await apiFetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })

        const result = await res.json()

        if (!result.success) {
          const serverError = result.error?.message || 'Request failed'
          const validationDetails = result.error?.details

          // Restore previous data on error
          setState({
            data: prevData,
            pending: false,
            error: serverError,
          })

          onError?.(new Error(serverError))

          return { success: false, error: serverError, details: validationDetails, data: prevData }
        }

        const newData = result.data
        setState({
          data: newData,
          pending: false,
          error: null,
        })

        onSuccess?.(newData)

        return { success: true, data: newData }
      } catch (err) {
        // Network error - restore previous state
        setState({
          data: prevData,
          pending: false,
          error: err instanceof Error ? err.message : 'Network error',
        })

        onError?.(err instanceof Error ? err : new Error('Network error'))

        return {
          success: false,
          error: err instanceof Error ? err.message : 'Network error',
          data: prevData,
        }
      }
    },
    [endpoint, method, state.data, state.error]
  )

  return { ...state, mutate }
}
