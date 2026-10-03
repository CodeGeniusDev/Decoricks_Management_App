import { NextResponse } from 'next/server'

/**
 * Standard API response format
 */
export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: {
    message: string
    code?: string
    details?: unknown
  }
  timestamp: string
}

/**
 * Create a success response
 * @param data - Response data
 * @param status - HTTP status code (default 200)
 * @returns NextResponse with success format
 */
export function successResponse<T>(data: T, status: number = 200): NextResponse<ApiResponse<T>> {
  return NextResponse.json(
    {
      success: true,
      data,
      timestamp: new Date().toISOString(),
    },
    { status }
  )
}

/**
 * Create an error response
 * @param message - Error message
 * @param status - HTTP status code (default 500)
 * @param code - Optional error code
 * @param details - Optional error details
 * @returns NextResponse with error format
 */
export function errorResponse(
  message: string,
  status: number = 500,
  code?: string,
  details?: unknown
): NextResponse<ApiResponse> {
  return NextResponse.json(
    {
      success: false,
      error: {
        message,
        code,
        details,
      },
      timestamp: new Date().toISOString(),
    },
    { status }
  )
}

/**
 * Create a validation error response
 * @param message - Validation error message
 * @param details - Validation error details
 * @returns NextResponse with 400 status
 */
export function validationError(message: string, details?: unknown): NextResponse<ApiResponse> {
  return errorResponse(message, 400, 'VALIDATION_ERROR', details)
}

/**
 * Create a not found error response
 * @param message - Not found message
 * @returns NextResponse with 404 status
 */
export function notFoundError(message: string = 'Resource not found'): NextResponse<ApiResponse> {
  return errorResponse(message, 404, 'NOT_FOUND')
}

/**
 * Create an unauthorized error response
 * @param message - Unauthorized message
 * @returns NextResponse with 401 status
 */
export function unauthorizedError(
  message: string = 'Unauthorized'
): NextResponse<ApiResponse> {
  return errorResponse(message, 401, 'UNAUTHORIZED')
}

/**
 * Create a forbidden error response
 * @param message - Forbidden message
 * @returns NextResponse with 403 status
 */
export function forbiddenError(message: string = 'Forbidden'): NextResponse<ApiResponse> {
  return errorResponse(message, 403, 'FORBIDDEN')
}

/**
 * Create a conflict error response
 * @param message - Conflict message
 * @returns NextResponse with 409 status
 */
export function conflictError(message: string = 'Resource conflict'): NextResponse<ApiResponse> {
  return errorResponse(message, 409, 'CONFLICT')
}
