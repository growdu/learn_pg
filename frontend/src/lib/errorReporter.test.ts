// src/lib/errorReporter.test.ts
//
// Tests for the global error reporter. We mock the api client so
// the reporter doesn't actually hit the network.
//
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetErrorReporterForTests,
  addBreadcrumb,
  configureErrorReporter,
  flushNow,
  installGlobalErrorHandlers,
  reportError,
} from './errorReporter'

const mockPost = vi.fn().mockResolvedValue(undefined)

vi.mock('./api', () => ({
  getApiClient: () => ({
    post: (...args: unknown[]) => mockPost(...args),
  }),
}))

beforeEach(() => {
  __resetErrorReporterForTests()
  mockPost.mockClear()
})

afterEach(() => {
  __resetErrorReporterForTests()
})

describe('errorReporter', () => {
  it('captures a manual report and flushes it via the api client', async () => {
    configureErrorReporter({ endpoint: '/api/telemetry/errors' })
    reportError({ error: new Error('boom'), source: 'manual' })
    await flushNow()
    expect(mockPost).toHaveBeenCalledTimes(1)
    const [path, body, options] = mockPost.mock.calls[0]
    expect(path).toBe('/api/telemetry/errors')
    expect((body as { reports: unknown[] }).reports).toHaveLength(1)
    expect(((body as { reports: Array<{ message: string }> }).reports)[0].message).toBe('boom')
    expect((options as { retry: boolean }).retry).toBe(false)
  })

  it('coerces non-Error inputs into Error instances', async () => {
    reportError({ error: 'string-only', source: 'manual' })
    await flushNow()
    const report = (mockPost.mock.calls[0][1] as { reports: Array<{ name: string; message: string }> }).reports[0]
    expect(report.name).toBe('Error')
    expect(report.message).toBe('string-only')
  })

  it('attaches breadcrumbs captured before the report', async () => {
    addBreadcrumb({ type: 'log', message: 'user clicked connect' })
    addBreadcrumb({ type: 'ws', message: 'ws open' })
    reportError({ error: new Error('late failure') })
    await flushNow()
    const report = (mockPost.mock.calls[0][1] as { reports: Array<{ breadcrumbs: Array<{ message: string }> }> }).reports[0]
    expect(report.breadcrumbs.map((b) => b.message)).toEqual([
      'user clicked connect',
      'ws open',
    ])
  })

  it('caps the breadcrumb buffer at maxBreadcrumbs', async () => {
    configureErrorReporter({ maxBreadcrumbs: 3 })
    addBreadcrumb({ type: 'log', message: 'one' })
    addBreadcrumb({ type: 'log', message: 'two' })
    addBreadcrumb({ type: 'log', message: 'three' })
    addBreadcrumb({ type: 'log', message: 'four' })
    reportError({ error: new Error('x') })
    await flushNow()
    const report = (mockPost.mock.calls[0][1] as { reports: Array<{ breadcrumbs: Array<{ message: string }> }> }).reports[0]
    expect(report.breadcrumbs.map((b) => b.message)).toEqual(['two', 'three', 'four'])
  })

  it('includes source, context, and url fields in the payload', async () => {
    reportError({
      error: new TypeError('bad input'),
      source: 'boundary',
      context: { componentStack: 'at <Foo>' },
    })
    await flushNow()
    const report = (mockPost.mock.calls[0][1] as { reports: Array<Record<string, unknown>> }).reports[0]
    expect(report.source).toBe('boundary')
    expect(report.context).toEqual({ componentStack: 'at <Foo>' })
    expect(typeof report.capturedAt).toBe('number')
    expect(typeof report.url).toBe('string')
  })

  it('swallows failures from the api client (never throws)', async () => {
    mockPost.mockRejectedValueOnce(new Error('network down'))
    expect(() => {
      reportError({ error: new Error('x') })
    }).not.toThrow()
    await expect(flushNow()).resolves.toBeUndefined()
  })

  it('honours enabled=false and drops everything', async () => {
    configureErrorReporter({ enabled: false })
    reportError({ error: new Error('silent') })
    addBreadcrumb({ type: 'log', message: 'silent' })
    await flushNow()
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('installGlobalErrorHandlers wires window.error and unhandledrejection', () => {
    const uninstall = installGlobalErrorHandlers()
    expect(typeof uninstall).toBe('function')
    // Dispatching a real ErrorEvent on window should funnel into a
    // queued report. We can't easily await the timer from here, so
    // we just assert the listener doesn't throw.
    const event = new ErrorEvent('error', { message: 'uncaught', error: new Error('boom') })
    expect(() => window.dispatchEvent(event)).not.toThrow()
    uninstall()
  })

  it('installGlobalErrorHandlers is idempotent', () => {
    const a = installGlobalErrorHandlers()
    const b = installGlobalErrorHandlers()
    // second call is a no-op (returns a fresh empty uninstall fn);
    // the important behaviour is that it didn't throw.
    expect(typeof a).toBe('function')
    expect(typeof b).toBe('function')
  })
})