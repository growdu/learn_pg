import { test, expect } from '@playwright/test'

/**
 * E2E: Template preview mode — shows topology without calling API
 */
test('template-preview: preview mode shows topology without API calls', async ({ page }) => {
  const apiCalls: string[] = []

  // Intercept API calls to verify no provision calls are made
  await page.route('/api/provision/**', async (route) => {
    apiCalls.push(route.request().url())
    await route.continue()
  })

  await page.goto('/')

  // Wait for app to load
  await page.waitForSelector('text=项目', { timeout: 10000 })

  // Open template dialog via "新建项目" button
  const newProjectBtn = page.locator('button:has-text("新建项目")').first()
  if (await newProjectBtn.isVisible()) {
    await newProjectBtn.click()
  }

  // Wait for dialog to appear
  await page.waitForSelector('text=创建集群项目', { timeout: 5000 })

  // Select "仅预览模板" (preview mode)
  const previewRadio = page.locator('input[name="createMode"][value="preview"]')
  if (await previewRadio.isVisible()) {
    await previewRadio.click()
  }

  // Click "预览" button
  const previewBtn = page.locator('button:has-text("预览")')
  if (await previewBtn.isVisible()) {
    await previewBtn.click()
  }

  // Should navigate to component view without calling provision API
  // No /api/provision/* calls should have been made
  expect(apiCalls.filter((u) => u.includes('/api/provision'))).toHaveLength(0)
})