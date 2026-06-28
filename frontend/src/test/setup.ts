// Global test setup. Auto-runs before each test file thanks to the
// setupFiles config in vitest.config.ts.
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// @testing-library/react doesn't auto-cleanup mounted trees between
// tests; we have to do it ourselves. Without this, two tests that
// each call render() leak the previous DOM, and queries that use
// getBy* start matching duplicates.
afterEach(() => {
  cleanup()
})
