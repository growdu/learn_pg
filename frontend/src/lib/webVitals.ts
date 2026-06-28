// src/lib/webVitals.ts
//
// Lightweight Web Vitals collection. Uses PerformanceObserver to
// capture the four CWV metrics the project cares about:
//   - LCP (Largest Contentful Paint) — loading performance
//   - FID (First Input Delay) — interactivity
//   - CLS (Cumulative Layout Shift) — visual stability
//   - TTFB (Time to First Byte) — server responsiveness
//
// INP is included as a bonus since it replaces FID in modern
// browsers. We use a single round-trip to /api/telemetry/vitals
// rather than one POST per metric.
//
// We deliberately avoid pulling in the `web-vitals` npm package —
// it's a 4kB dependency that does roughly the same thing as the
// 50 lines below.

import { getApiClient } from './api'

export interface VitalSample {
  name: 'LCP' | 'FID' | 'CLS' | 'INP' | 'TTFB'
  value: number
  rating: 'good' | 'needs-improvement' | 'poor'
  id: string
  navigationType?: string
}

export interface VitalReporterConfig {
  endpoint?: string
  /** Disable collection entirely (useful for tests / private mode). */
  enabled?: boolean
  /** Send a sample after this much idle time. Defaults to 5_000ms. */
  flushDelayMs?: number
}

const DEFAULT_ENDPOINT = '/api/telemetry/vitals'
const DEFAULT_FLUSH_DELAY = 5_000

// CWV "good" thresholds (2024 revision). These match what
// web.dev publishes and what Lighthouse uses internally.
const THRESHOLDS: Record<VitalSample['name'], [number, number]> = {
  LCP: [2_500, 4_000],
  FID: [100, 300],
  CLS: [0.1, 0.25],
  INP: [200, 500],
  TTFB: [800, 1_800],
}

let activeConfig: Required<VitalReporterConfig> = {
  endpoint: DEFAULT_ENDPOINT,
  enabled: true,
  flushDelayMs: DEFAULT_FLUSH_DELAY,
}
let samples: VitalSample[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let observersInstalled = false

function rate(name: VitalSample['name'], value: number): VitalSample['rating'] {
  const [good, poor] = THRESHOLDS[name]
  if (value <= good) return 'good'
  if (value <= poor) return 'needs-improvement'
  return 'poor'
}

function record(name: VitalSample['name'], value: number, id = '', navigationType?: string) {
  if (!activeConfig.enabled) return
  samples.push({ name, value, rating: rate(name, value), id, navigationType })
  scheduleFlush()
}

function scheduleFlush() {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void doFlush()
  }, activeConfig.flushDelayMs)
}

async function doFlush(): Promise<void> {
  if (samples.length === 0) return
  const batch = samples
  samples = []
  try {
    const client = getApiClient()
    await client.post(activeConfig.endpoint, { samples: batch }, {
      retry: false,
      timeoutMs: 3_000,
    })
  } catch {
    // Drop silently — same rule as error reporter.
  }
}

export async function flushVitals(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  await doFlush()
}

export function configureVitalReporter(config: VitalReporterConfig): void {
  activeConfig = {
    endpoint: config.endpoint ?? DEFAULT_ENDPOINT,
    enabled: config.enabled ?? true,
    flushDelayMs: config.flushDelayMs ?? DEFAULT_FLUSH_DELAY,
  }
}

/** Start observing CWV metrics. Idempotent. Returns an uninstall
 *  function that disconnects the observers. */
export function installWebVitals(): () => void {
  if (observersInstalled || typeof window === 'undefined') {
    return () => {}
  }
  observersInstalled = true

  const cleanups: Array<() => void> = []

  // TTFB from Navigation Timing API — available immediately.
  try {
    const nav = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined
    if (nav) {
      const ttfb = nav.responseStart - nav.requestStart
      record('TTFB', ttfb, nav.name, nav.type)
    }
  } catch {
    // Performance API not available — skip.
  }

  // LCP
  if ('PerformanceObserver' in window) {
    try {
      const lcpObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries()
        const last = entries[entries.length - 1] as PerformanceEntry & { id?: string }
        if (last) record('LCP', last.startTime, last.id ?? '')
      })
      lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true })
      cleanups.push(() => lcpObserver.disconnect())
    } catch {
      // Browser doesn't support LCP — fine.
    }

    // FID (and INP fallback via Event Timing)
    try {
      const fidObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as Array<PerformanceEntry & { processingStart?: number; duration: number }>) {
          if (typeof entry.processingStart === 'number') {
            const fid = entry.processingStart - entry.startTime
            // Modern browsers fire 'first-input' as FID too.
            record('FID', fid, entry.entryType ?? '')
            record('INP', entry.duration, entry.entryType ?? '')
          }
        }
      })
      fidObserver.observe({ type: 'first-input', buffered: true })
      cleanups.push(() => fidObserver.disconnect())
    } catch {
      // Skip
    }

    // Layout Instability (CLS)
    try {
      let clsValue = 0
      const clsObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as Array<PerformanceEntry & { hadRecentInput?: boolean; value: number }>) {
          if (!entry.hadRecentInput) clsValue += entry.value
        }
        record('CLS', clsValue)
      })
      clsObserver.observe({ type: 'layout-shift', buffered: true })
      cleanups.push(() => clsObserver.disconnect())
    } catch {
      // Skip
    }
  }

  return () => {
    cleanups.forEach((fn) => fn())
    observersInstalled = false
  }
}

/** Test-only helper. */
export function __resetVitalReporterForTests(): void {
  samples = []
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  activeConfig = {
    endpoint: DEFAULT_ENDPOINT,
    enabled: true,
    flushDelayMs: DEFAULT_FLUSH_DELAY,
  }
  observersInstalled = false
}