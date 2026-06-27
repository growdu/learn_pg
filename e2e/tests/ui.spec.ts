import { test, expect } from '@playwright/test'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3001'

/**
 * UI smoke tests — verify the frontend loads and key UI elements are present.
 */

test('ui: frontend loads at root URL', async ({ page }) => {
  await page.goto(BASE)
  await expect(page).toHaveTitle(/.*/)
})

test('ui: project home view is visible after load', async ({ page }) => {
  await page.goto(BASE)
  await page.waitForLoadState('networkidle')
  const header = page.locator('h2', { hasText: '项目总览' })
  await expect(header.or(page.locator('text=项目总览'))).toBeVisible({ timeout: 15_000 })
})

test('ui: new project button exists in project home', async ({ page }) => {
  await page.goto(BASE)
  await page.waitForLoadState('networkidle')
  const btn = page.getByRole('button', { name: '新建项目' })
  await expect(btn.or(page.getByRole('button', { name: /新建/i }))).toBeVisible({ timeout: 15_000 })
})

test('ui: create from template button exists', async ({ page }) => {
  await page.goto(BASE)
  await page.waitForLoadState('networkidle')
  const btn = page.getByRole('button', { name: /模板/i })
  await expect(btn).toBeVisible({ timeout: 15_000 })
})
