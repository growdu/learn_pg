// src/lib/errorReporter.ts
//
// Lightweight client-side error reporting. Captures:
//   - Uncaught exceptions (window.error)
//   - Unhandled promise rejections (window.unhandledrejection)
//   - Manual calls via reportError(...) from app code / ErrorBoundary
//
// Reports are batched and flushed to POST /api/telemetry/errors on
// the backend. The send uses the same fetch wrapper the rest of the
// app uses, but failure to report is *never* rethrown — a broken
// telemetry pipeline must never crash the UI.

import { getApiClient } from './api'

/** What a manual report looks like. */
export interface ErrorReport {
  /** Short message — `error.message` or `String(error)`. */
  message: string
  /** Error class name when available (`Error`, `TypeError`, …). */
  name?: string
  /** Full stack trace if we have one. */
  stack?: string
  /** Source: window event vs manual call. */
  source: 'uncaught' | 'unhandledrejection' | 'boundary' | 'manual'
  /** Where in the app the error happened (URL + route). */
  url?: string
  /** Last few breadcrumbs (capped at MAX_BREADCRUMBS). */
  breadcrumbs?: Breadcrumb[]
  /** Free-form structured data attached at the call site. */
  context?: Record<string, unknown>
  /** When the report was captured (epoch ms). */
  capturedAt: number
}

/** A breadcrumb is a small structured event that helps correlate
 *  the report with what the user was doing right before the crash. */
export interface Breadcrumb {
  type: 'log' | 'click' | 'nav' | 'ws' | 'fetch'
  /**
   * Severity hint. 'info' is the default for routine lifecycle events;
   * 'warn' is for transient issues that recovered (e.g. a retry);
   * 'error' is for events that directly caused or preceded a
   * reported error.
   */
  level?: 'info' | 'warn' | 'error'
  message: string
  timestamp: number
  data?: Record<string, unknown>
}

/** How the reporter is configured. */
export interface ErrorReporterConfig {
  /** Backend endpoint to POST reports to. Defaults to /api/telemetry/errors. */
  endpoint?: string
  /** Max breadcrumbs retained in memory. Defaults to 50. */
  maxBreadcrumbs?: number
  /** Disable reporting entirely (useful for tests / private mode). */
  enabled?: boolean
}

const DEFAULT_ENDPOINT = '/api/telemetry/errors'
const DEFAULT_MAX_BREADCRUMBS = 50

let queue: ErrorReport[] = []
let breadcrumbs: Breadcrumb[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let installedListeners = false
let activeConfig: Required<ErrorReporterConfig> = {
  endpoint: DEFAULT_ENDPOINT,
  maxBreadcrumbs: DEFAULT_MAX_BREADCRUMBS,
  enabled: true,
}

/** Append a breadcrumb. Safe to call from anywhere — never throws. */
export function getBreadcrumbs(): readonly Breadcrumb[] {
  return breadcrumbs
}

export function addBreadcrumb(breadcrumb: Omit<Breadcrumb, 'timestamp'>): void {
  if (!activeConfig.enabled) return
  const entry: Breadcrumb = { ...breadcrumb, timestamp: Date.now() }
  breadcrumbs.push(entry)
  if (breadcrumbs.length > activeConfig.maxBreadcrumbs) {
    breadcrumbs.splice(0, breadcrumbs.length - activeConfig.maxBreadcrumbs)
  }
}

/** Capture a manual error report and queue it for flushing. */
export function reportError(input: {
  error: unknown
  source?: ErrorReport['source']
  context?: Record<string, unknown>
}): void {
  if (!activeConfig.enabled) return
  const { error, source = 'manual', context } = input
  const e = error instanceof Error ? error : new Error(String(error))
  queue.push({
    message: e.message,
    name: e.name,
    stack: e.stack,
    source,
    url: typeof window !== 'undefined' ? window.location?.href : undefined,
    breadcrumbs: [...breadcrumbs],
    context,
    capturedAt: Date.now(),
  })
  scheduleFlush()
}

/** Configure the reporter. Call once at app boot. */
export function configureErrorReporter(config: ErrorReporterConfig): void {
  activeConfig = {
    endpoint: config.endpoint ?? DEFAULT_ENDPOINT,
    maxBreadcrumbs: config.maxBreadcrumbs ?? DEFAULT_MAX_BREADCRUMBS,
    enabled: config.enabled ?? true,
  }
}

/** Install global listeners for uncaught exceptions + unhandled
 *  rejections. Idempotent — calling twice is a no-op. */
export function installGlobalErrorHandlers(): () => void {
  if (installedListeners || typeof window === 'undefined') {
    return () => {}
  }
  installedListeners = true

  const onError = (event: ErrorEvent) => {
    reportError({
      error: event.error ?? new Error(event.message),
      source: 'uncaught',
      context: { filename: event.filename, lineno: event.lineno, colno: event.colno },
    })
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    reportError({
      error: event.reason,
      source: 'unhandledrejection',
    })
  }
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)

  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
    installedListeners = false
  }
}

/** Force a synchronous flush. Mostly used by tests; the app usually
 *  lets the timer fire. */
export async function flushNow(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  await flush()
}

function scheduleFlush(): void {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flush()
  }, 1_000)
}

async function flush(): Promise<void> {
  if (queue.length === 0) return
  const batch = queue
  queue = []
  try {
    const client = getApiClient()
    await client.post(activeConfig.endpoint, { reports: batch }, {
      // Telemetry never blocks the UI for long, and never retries —
      // if the backend is down we'd rather drop than balloon the
      // retry queue.
      retry: false,
      timeoutMs: 3_000,
    })
  } catch {
    // Swallow. A broken telemetry pipeline must never crash the app.
    // Drop the batch silently.
  }
}

/** Test-only helper: reset all internal state. */
export function __resetErrorReporterForTests(): void {
  queue = []
  breadcrumbs = []
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  activeConfig = {
    endpoint: DEFAULT_ENDPOINT,
    maxBreadcrumbs: DEFAULT_MAX_BREADCRUMBS,
    enabled: true,
  }
  installedListeners = false
}