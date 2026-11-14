import { test, expect } from '@playwright/test'
import {
  BASE_URL,
  CSRF_HEADER,
  E2E_PASSWORD,
  FOUNDER_EMAIL,
  FOUNDER_STATE,
  clientIpHeaders,
  csrfFromState,
} from './helpers'

/**
 * Custom role journey: Founder creates a custom role, creates a user with that role,
 * and verifies the user has least-privilege access.
 *
 * Uses decoricks_test database only (configured via environment).
 */

test.describe('custom role creation and assignment', () => {
  test.use({ storageState: FOUNDER_STATE })

  test('Founder creates a custom role and assigns it to a new user', async ({ page, request }) => {
    const csrfToken = csrfFromState(FOUNDER_STATE)

    // Step 1: Create a custom role "staff" via API
    const roleResponse = await request.post(`${BASE_URL}/api/roles`, {
      headers: {
        'Content-Type': 'application/json',
        [CSRF_HEADER]: csrfToken,
      },
      data: {
        name: 'staff',
        displayName: 'Staff',
        permissions: {
          finance: { view: true, create: false, edit: false, delete: false, approve: false },
          budget: { view: false, create: false, edit: false, delete: false, approve: false },
          inventory: { view: false, create: false, edit: false, delete: false },
          sales: { view: false, create: false, edit: false, delete: false },
          tasks: { view: true, create: false, edit: false, delete: false },
          chat: { view: true, create: true, edit: false, delete: false },
          suppliers: { view: false, create: false, edit: false, delete: false },
          settings: { view: false, edit: false },
          users: { view: false, create: false, edit: false, delete: false },
          'inventory.lahore_stock': { create: false },
          'sales.full_edit': { create: false },
        },
      },
    })

    expect(roleResponse.ok()).toBeTruthy()
    const roleData = await roleResponse.json()
    expect(roleData.success).toBe(true)
    expect(roleData.role.name).toBe('staff')
    expect(roleData.role.displayName).toBe('Staff')

    const roleId = roleData.role._id

    // Step 2: Create a user "Junaid" with the custom role
    const uniqueEmail = `junaid-${Date.now()}@decoricks.test`
    const userResponse = await request.post(`${BASE_URL}/api/users`, {
      headers: {
        'Content-Type': 'application/json',
        [CSRF_HEADER]: csrfToken,
      },
      data: {
        name: 'Junaid',
        email: uniqueEmail,
        role: 'staff',
        password: 'TempPassword123',
      },
    })

    expect(userResponse.ok()).toBeTruthy()
    const userData = await userResponse.json()
    expect(userData.success).toBe(true)

    // Step 3: Navigate to Settings and verify the role appears in the UI
    await page.goto('/settings')
    await page.getByRole('tab', { name: 'Permissions' }).click()
    await expect(page.getByRole('combobox', { name: 'Role' })).toBeVisible()

    // Verify the custom role appears in the dropdown
    const roleSelect = page.getByRole('combobox', { name: 'Role' })
    await roleSelect.click()
    await expect(page.getByRole('option', { name: 'Staff' })).toBeVisible()

    // Step 4: Navigate to Users tab and verify the custom role appears in the role dropdown
    await page.getByRole('tab', { name: 'Users' }).click()
    await page.getByRole('button', { name: 'Add user' }).click()
    const userRoleSelect = page.getByRole('combobox', { name: 'Role' })
    await userRoleSelect.click()
    await expect(page.getByRole('option', { name: 'Staff' })).toBeVisible()

    // Close the modal
    await page.getByRole('button', { name: 'Cancel' }).click()

    // Step 5: Verify Junaid appears in the users table
    await expect(page.getByText(uniqueEmail)).toBeVisible()

    // Cleanup: Delete the role (must delete user first)
    await request.delete(`${BASE_URL}/api/users/${userData.user._id}`, {
      headers: {
        [CSRF_HEADER]: csrfToken,
      },
    })

    await request.delete(`${BASE_URL}/api/roles/${roleId}`, {
      headers: {
        [CSRF_HEADER]: csrfToken,
      },
    })
  })
})

test.describe('custom role user permissions', () => {
  test('custom role user can only access allowed screens', async ({ page, context }) => {
    // First, create the role and user via API with a fresh session
    const context2 = await context.browser()?.newContext()
    if (!context2) throw new Error('Could not create context')

    const page2 = await context2.newPage()
    await page2.setExtraHTTPHeaders(clientIpHeaders())

    // Sign in as Founder to set up the test
    await page2.goto('/login')
    await page2.getByLabel('Email', { exact: true }).fill(FOUNDER_EMAIL)
    await page2.getByLabel('Password', { exact: true }).fill(E2E_PASSWORD)
    await page2.getByRole('button', { name: 'Sign in' }).click()
    await expect(page2).toHaveURL((url) => url.pathname === '/', { timeout: 15_000 })

    // Get CSRF token from cookies
    const cookies = await context2.cookies()
    const csrfCookie = cookies.find((c) => c.name === 'decoricks_csrf')
    const csrfToken = csrfCookie?.value ?? ''

    // Create custom role
    const uniqueRoleName = `staff-${Date.now()}`
    const roleResponse = await page2.request.post(`${BASE_URL}/api/roles`, {
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      data: {
        name: uniqueRoleName,
        displayName: 'Staff',
        permissions: {
          finance: { view: true, create: false, edit: false, delete: false, approve: false },
          budget: { view: false, create: false, edit: false, delete: false, approve: false },
          inventory: { view: false, create: false, edit: false, delete: false },
          sales: { view: false, create: false, edit: false, delete: false },
          tasks: { view: true, create: false, edit: false, delete: false },
          chat: { view: true, create: true, edit: false, delete: false },
          suppliers: { view: false, create: false, edit: false, delete: false },
          settings: { view: false, edit: false },
          users: { view: false, create: false, edit: false, delete: false },
          'inventory.lahore_stock': { create: false },
          'sales.full_edit': { create: false },
        },
      },
    })

    expect(roleResponse.ok()).toBeTruthy()
    const roleData = await roleResponse.json()

    // Create user with custom role
    const uniqueEmail = `junaid-${Date.now()}@decoricks.test`
    const userResponse = await page2.request.post(`${BASE_URL}/api/users`, {
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      data: {
        name: 'Junaid',
        email: uniqueEmail,
        role: uniqueRoleName,
        password: 'TempPassword123',
      },
    })

    expect(userResponse.ok()).toBeTruthy()

    // Sign out Founder
    await page2.getByRole('button', { name: /account menu/i }).click()
    await page2.getByRole('menuitem', { name: 'Sign out' }).click()
    await expect(page2).toHaveURL(/\/login/, { timeout: 15_000 })

    // Sign in as Junaid
    await page2.getByLabel('Email', { exact: true }).fill(uniqueEmail)
    await page2.getByLabel('Password', { exact: true }).fill('TempPassword123')
    await page2.getByRole('button', { name: 'Sign in' }).click()

    // Should be redirected to change password on first sign-in
    await expect(page2).toHaveURL(/\/change-password/, { timeout: 15_000 })

    // Change password
    await page2.getByLabel('New password', { exact: true }).fill('NewPassword123')
    await page2.getByLabel('Confirm new password', { exact: true }).fill('NewPassword123')
    await page2.getByRole('button', { name: 'Change password' }).click()
    await expect(page2).toHaveURL((url) => url.pathname === '/', { timeout: 15_000 })

    // Verify allowed screens are accessible
    await expect(page2.getByRole('link', { name: 'Dashboard' })).toBeVisible()
    await expect(page2.getByRole('link', { name: 'Tasks' })).toBeVisible()
    await expect(page2.getByRole('link', { name: 'Chat' })).toBeVisible()

    // Verify forbidden screens are not accessible or show permission denied
    await page2.getByRole('link', { name: 'Finance' }).click()
    await expect(page2.locator('body')).toContainText('Forbidden', { timeout: 5000 })

    await page2.getByRole('link', { name: 'Budget' }).click()
    await expect(page2.locator('body')).toContainText('Forbidden', { timeout: 5000 })

    await page2.getByRole('link', { name: 'Inventory' }).click()
    await expect(page2.locator('body')).toContainText('Forbidden', { timeout: 5000 })

    await page2.getByRole('link', { name: 'Sales' }).click()
    await expect(page2.locator('body')).toContainText('Forbidden', { timeout: 5000 })

    await page2.getByRole('link', { name: 'Settings' }).click()
    await expect(page2.locator('body')).toContainText('Forbidden', { timeout: 5000 })

    // Cleanup: Sign back in as Founder and delete the user and role
    await page2.goto('/login')
    await page2.getByLabel('Email', { exact: true }).fill(FOUNDER_EMAIL)
    await page2.getByLabel('Password', { exact: true }).fill(E2E_PASSWORD)
    await page2.getByRole('button', { name: 'Sign in' }).click()
    await expect(page2).toHaveURL((url) => url.pathname === '/', { timeout: 15_000 })

    const cookies2 = await context2.cookies()
    const csrfCookie2 = cookies2.find((c) => c.name === 'decoricks_csrf')
    const csrfToken2 = csrfCookie2?.value ?? ''

    const userData2 = await userResponse.json()
    await page2.request.delete(`${BASE_URL}/api/users/${userData2.user._id}`, {
      headers: {
        'x-csrf-token': csrfToken2,
      },
    })

    await page2.request.delete(`${BASE_URL}/api/roles/${roleData.role._id}`, {
      headers: {
        'x-csrf-token': csrfToken2,
      },
    })

    await context2.close()
  })
})
