import { test, expect } from '@playwright/test'
import { api } from '../helpers/api'

/**
 * E2E: Manual database connection via /api/connect
 */
test('manual-connect: connect to local PostgreSQL', async ({ page }) => {
  // Navigate to the app
  await page.goto('/')

  // Wait for app to load
  await page.waitForSelector('text=项目', { timeout: 10000 })

  // Open connect dialog if present (via Header)
  const connectBtn = page.locator('button:has-text("连接")').first()
  if (await connectBtn.isVisible()) {
    await connectBtn.click()
  }

  // Try direct connect API call
  const result = await api.connect('127.0.0.1', 5432, 'postgres', 'postgres', 'postgres')
  expect(result.success).toBeTruthy()
})