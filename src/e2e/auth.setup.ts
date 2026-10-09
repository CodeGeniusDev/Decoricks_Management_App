import fs from 'node:fs'
import { test } from '@playwright/test'
import {
  AFNAN_EMAIL,
  AFNAN_STATE,
  AUTH_DIR,
  E2E_PASSWORD,
  FOUNDER_EMAIL,
  FOUNDER_STATE,
} from './helpers'

/**
 * Signs the Founder and a Partner in once and saves their cookies, so the rest
 * of the suite can start authenticated via `storageState`. Running the real
 * login form here doubles as a smoke test of the auth flow.
 */

fs.mkdirSync(AUTH_DIR, { recursive: true })

const signIn = async (
  page: import('@playwright/test').Page,
  email: string,
  password: string
) => {
  await page.goto('/login')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 })
  await page.locator('#main-content').waitFor({ state: 'visible', timeout: 20_000 })
}

test('authenticate as the Founder', async ({ page }) => {
  await signIn(page, FOUNDER_EMAIL, E2E_PASSWORD)
  await page.context().storageState({ path: FOUNDER_STATE })
})

test('authenticate as a Partner', async ({ page }) => {
  await signIn(page, AFNAN_EMAIL, E2E_PASSWORD)
  await page.context().storageState({ path: AFNAN_STATE })
})
