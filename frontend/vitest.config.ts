import { defineConfig } from 'vitest/config'

// Tests for .tsx components run in jsdom so React and the DOM
// APIs are available. Tests for plain .ts modules run in node so
// the test process is faster and the global DOM isn't dragged in.
export default defineConfig({
  test: {
    environmentMatchGlobs: [
      ['src/**/*.test.tsx', 'jsdom'],
      ['src/**/*.test.ts', 'node'],
    ],
    setupFiles: ['./src/test/setup.ts'],
    globals: false,
  },
})
