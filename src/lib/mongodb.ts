import { MongoClient, Db } from 'mongodb'
import { getEnv } from './env'

let client: MongoClient
let clientPromise: Promise<MongoClient> | null = null
let db: Db

// In development mode, use a global variable to preserve the connection
// across hot reloads. In production, this is not needed.
declare global {
  var _mongoClientPromise: Promise<MongoClient> | null
}

const getClientPromise = (): Promise<MongoClient> => {
  if (clientPromise) return clientPromise

  const env = getEnv()
  const uri = env.MONGODB_URI
  const options = {}

  if (process.env.NODE_ENV === 'development') {
    if (!global._mongoClientPromise) {
      client = new MongoClient(uri, options)
      global._mongoClientPromise = client.connect()
    }
    clientPromise = global._mongoClientPromise
  } else {
    client = new MongoClient(uri, options)
    clientPromise = client.connect()
  }

  return clientPromise
}

export async function getDatabase(): Promise<Db> {
  try {
    const client = await getClientPromise()
    db = client.db()
    return db
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error)
    throw new Error('Database connection failed')
  }
}

export async function closeDatabase(): Promise<void> {
  try {
    const client = await getClientPromise()
    await client.close()
  } catch (error) {
    console.error('Failed to close MongoDB connection:', error)
  }
}

// Health check function
export async function healthCheck(): Promise<{ status: string; message: string }> {
  try {
    const db = await getDatabase()
    // Ping the database
    await db.admin().ping()
    return { status: 'healthy', message: 'Database connection successful' }
  } catch (error) {
    console.error('Database health check failed:', error)
    return {
      status: 'unhealthy',
      message: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}
