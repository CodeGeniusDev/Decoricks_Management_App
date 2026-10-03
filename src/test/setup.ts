import { beforeAll, afterAll } from 'vitest'

// Mock environment variables for tests
process.env.MONGODB_URI = 'mongodb://localhost:27017/test'
process.env.NEXTAUTH_SECRET = 'test-secret'
process.env.NEXTAUTH_URL = 'http://localhost:3000'

// Setup before all tests
beforeAll(() => {
  console.log('Test setup complete')
})

// Cleanup after all tests
afterAll(() => {
  console.log('Test cleanup complete')
})
