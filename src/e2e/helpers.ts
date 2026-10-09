import fs from 'node:fs'
import path from 'node:path'

const PORT = Number(process.env.E2E_PORT ?? 3111)

export const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`
export const AUTH_DIR = path.join(__dirname, '.auth')
export const FOUNDER_STATE = path.join(AUTH_DIR, 'founder.json')
export const AFNAN_STATE = path.join(AUTH_DIR, 'afnan.json')

export const FOUNDER_EMAIL = process.env.E2E_FOUNDER_EMAIL ?? 'abdullah@decoricks.com'
export const AFNAN_EMAIL = process.env.E2E_AFNAN_EMAIL ?? 'afnan@decoricks.com'
export const E2E_PASSWORD = process.env.E2E_PASSWORD ?? 'Decoricks2026'

export const CSRF_COOKIE = 'decoricks_csrf'
export const CSRF_HEADER = 'x-csrf-token'

/** Reads the JS-readable CSRF cookie out of a saved storage state. */
export const csrfFromState = (file: string): string => {
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    cookies?: Array<{ name: string; value: string }>
  }
  return state.cookies?.find((entry) => entry.name === CSRF_COOKIE)?.value ?? ''
}
