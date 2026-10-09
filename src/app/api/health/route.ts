import { NextResponse } from 'next/server'
import { healthCheck } from '@/lib/mongodb'
import { getEnv } from '@/lib/env'

export async function GET() {
  try {
    // Validate environment variables
    getEnv()

    const result = await healthCheck()

    if (result.status === 'healthy') {
      return NextResponse.json(
        {
          status: 'ok',
          database: result.status,
          message: result.status === "healthy" ? "Database connected" : "Database unavailable",
          timestamp: new Date().toISOString(),
        },
        { status: 200 }
      )
    } else {
      return NextResponse.json(
        {
          status: 'error',
          database: result.status,
          message: result.status === "healthy" ? "Database connected" : "Database unavailable",
          timestamp: new Date().toISOString(),
        },
        { status: 503 }
      )
    }
  } catch (error) {
    return NextResponse.json(
      {
        status: 'error',
        database: 'unreachable',
        message: "Service unavailable",
        timestamp: new Date().toISOString(),
      },
      { status: 503 }
    )
  }
}
