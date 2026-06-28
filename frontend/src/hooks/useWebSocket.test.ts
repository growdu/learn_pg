// src/hooks/useWebSocket.test.ts
//
// Unit tests for the reconnect-aware useWebSocket hook. We use a
// MockWebSocket class that exposes the same readyState transitions
// as the real one but lets the test drive open/close/error events
// deterministically. This is faster and more reliable than mocking
// the global WebSocket constructor and lets us assert on the hook's
// exponential-backoff behaviour without real timers in the loop.
//
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

// Build a minimal WebSocket stand-in. Vitest's environment is node by
// default for .ts files, so globalThis.WebSocket may not exist.
class MockWebSocket {
  static OPEN = 1
  static CLOSED = 3
  static CLOSING = 2
  static CONNECTING = 0

  url: string
  readyState: number = MockWebSocket.CONNECTING
  onopen: ((e?: unknown) => void) | null = null
  onclose: ((e?: { code: number; reason: string; wasClean: boolean }) => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((e?: unknown) => void) | null = null

  sent: string[] = []
  closeImpl: ((code?: number, reason?: string) => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close(code?: number, reason?: string) {
    this.closeImpl?.(code, reason)
  }
  // Test helpers — drive lifecycle events.
  _open() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.({})
  }
  _close(code = 1006, reason = 'abnormal') {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({ code, reason, wasClean: code === 1000 })
  }
  _message(data: unknown) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) })
  }
  _error() {
    this.onerror?.(new Event('error'))
  }
  static instances: MockWebSocket[] = []
  static reset() {
    MockWebSocket.instances.length = 0
  }
}

// Install before importing the hook module so the WebSocket reference
// inside the hook picks up our class.
;(globalThis as { WebSocket: unknown }).WebSocket = MockWebSocket

// Now safe to import. Use Promise.then to avoid top-level await
// (vitest supports it but tsc with ES2020 lib does not).
const hookModule = await import('./useWebSocket')
const useWebSocket = hookModule.useWebSocket
const backoffDelay = hookModule.backoffDelay

beforeEach(() => {
  MockWebSocket.reset()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// The event store calls zustand; for these tests we only need the
// path where the message is JSON-parseable ProbeEvent-shaped. Use
// a minimal stub that survives the hook's import-time wiring.
import { useEventStore } from '../stores/eventStore'
const addEventSpy = vi.fn()
useEventStore.setState({ addEvent: addEventSpy } as never)

describe('useWebSocket', () => {
  it('starts in connecting status and opens on WS open event', () => {
    const { result } = renderHook(() => useWebSocket())
    expect(result.current.status).toBe('connecting')
    act(() => {
      MockWebSocket.instances[0]._open()
    })
    expect(result.current.status).toBe('open')
    expect(result.current.connected).toBe(true)
  })

  it('reconnects with exponential backoff after an abnormal close', () => {
    renderHook(() =>
      useWebSocket({ baseBackoffMs: 100, maxBackoffMs: 10_000, heartbeatMs: 0 }),
    )
    const ws0 = MockWebSocket.instances[0]
    act(() => ws0._open())
    act(() => ws0._close())
    // After close the hook schedules a reconnect on a 100ms-base backoff.
    // Attempt 0 ⇒ delay ∈ [0, 100).
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(MockWebSocket.instances).toHaveLength(2)
    act(() => MockWebSocket.instances[1]._close())
    // Attempt 1 ⇒ delay ∈ [0, 200).
    act(() => {
      vi.advanceTimersByTime(250)
    })
    expect(MockWebSocket.instances).toHaveLength(3)
  })

  it('resets the backoff counter after a successful open', () => {
    renderHook(() =>
      useWebSocket({ baseBackoffMs: 100, maxBackoffMs: 10_000, heartbeatMs: 0 }),
    )
    act(() => MockWebSocket.instances[0]._close())
    act(() => vi.advanceTimersByTime(150))
    expect(MockWebSocket.instances).toHaveLength(2)
    // Successful open on attempt #2
    act(() => MockWebSocket.instances[1]._open())
    expect(MockWebSocket.instances[1].readyState).toBe(MockWebSocket.OPEN)
    // Drop again — attempt counter should be back to 0, so the next
    // delay is in [0, 100) again.
    act(() => MockWebSocket.instances[1]._close())
    act(() => vi.advanceTimersByTime(150))
    expect(MockWebSocket.instances).toHaveLength(3)
  })

  it('caps reconnect attempts at maxReconnectAttempts and surfaces a failed status', () => {
    const onReconnectFailed = vi.fn()
    renderHook(() =>
      useWebSocket({
        baseBackoffMs: 50,
        maxBackoffMs: 1000,
        heartbeatMs: 0,
        maxReconnectAttempts: 2,
        onReconnectFailed,
      }),
    )
    // First connection fails
    act(() => MockWebSocket.instances[0]._close())
    // After backoff: attempt #1 fires
    act(() => vi.advanceTimersByTime(200))
    expect(MockWebSocket.instances).toHaveLength(2)
    act(() => MockWebSocket.instances[1]._close())
    act(() => vi.advanceTimersByTime(2000))
    // After backoff: attempt #2 fires
    expect(MockWebSocket.instances).toHaveLength(3)
    act(() => MockWebSocket.instances[2]._close())
    act(() => vi.advanceTimersByTime(5000))
    // No further reconnects — we hit the cap
    expect(MockWebSocket.instances).toHaveLength(3)
    expect(onReconnectFailed).toHaveBeenCalledWith(2)
  })

  it('does not reconnect after explicit disconnect', () => {
    const { result } = renderHook(() =>
      useWebSocket({ baseBackoffMs: 100, heartbeatMs: 0 }),
    )
    act(() => MockWebSocket.instances[0]._open())
    act(() => {
      result.current.disconnect()
    })
    expect(result.current.status).toBe('closed')
    act(() => vi.advanceTimersByTime(5_000))
    // Only the original instance; no reconnect.
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('sends a heartbeat on the configured interval', () => {
    renderHook(() => useWebSocket({ heartbeatMs: 1_000, staleAfterMs: 0 }))
    act(() => MockWebSocket.instances[0]._open())
    act(() => vi.advanceTimersByTime(2_500))
    expect(MockWebSocket.instances[0].sent.length).toBeGreaterThanOrEqual(2)
    expect(JSON.parse(MockWebSocket.instances[0].sent[0])).toEqual({ type: 'ping' })
  })

  it('closes the socket if no inbound message arrives within staleAfterMs', () => {
    const ws0 = (() => {
      let captured: MockWebSocket | null = null
      const origClose = MockWebSocket.prototype.close
      MockWebSocket.prototype.close = function (this: MockWebSocket, code?: number, reason?: string) {
        captured = this
        // Call our _close helper so the hook sees the close event.
        this._close(code ?? 4000, reason ?? 'stale')
      }
      return () => {
        MockWebSocket.prototype.close = origClose
        return captured
      }
    })()
    renderHook(() =>
      useWebSocket({ heartbeatMs: 0, staleAfterMs: 500, baseBackoffMs: 10, maxBackoffMs: 10 }),
    )
    const ws = MockWebSocket.instances[0]
    act(() => ws._open())
    act(() => vi.advanceTimersByTime(700))
    expect(ws0()).toBe(ws) // stale timer called close on the live socket
  })

  it('surfaces ApiError-shaped error from onerror to lastError', () => {
    const { result } = renderHook(() => useWebSocket())
    act(() => MockWebSocket.instances[0]._error())
    expect(result.current.lastError).toBe('WebSocket connection error')
  })

  it('honours a custom url option', () => {
    renderHook(() => useWebSocket({ url: 'ws://example.test/ws' }))
    expect(MockWebSocket.instances[0].url).toBe('ws://example.test/ws')
  })

  it('send() is a no-op when the socket is not open', () => {
    const { result } = renderHook(() => useWebSocket())
    // Before open
    expect(() => result.current.send({ hello: 'world' })).not.toThrow()
    expect(MockWebSocket.instances[0].sent).toHaveLength(0)
    // After open
    act(() => MockWebSocket.instances[0]._open())
    act(() => {
      result.current.send({ hello: 'world' })
    })
    expect(MockWebSocket.instances[0].sent).toHaveLength(1)
    expect(JSON.parse(MockWebSocket.instances[0].sent[0])).toEqual({ hello: 'world' })
  })

  it('ignores heartbeat-shaped messages and forwards ProbeEvent-shaped messages', () => {
    addEventSpy.mockClear()
    renderHook(() => useWebSocket())
    const ws = MockWebSocket.instances[0]
    act(() => ws._open())
    act(() => ws._message({ type: 'ping' }))
    expect(addEventSpy).not.toHaveBeenCalled()
    act(() => ws._message({ type: 'wal_insert', data: { x: 1 } }))
    expect(addEventSpy).toHaveBeenCalledWith({ type: 'wal_insert', data: { x: 1 } })
  })
})

describe('backoffDelay', () => {
  it('returns 0 for attempt 0 with a tiny base', () => {
    // attempt=0, base=1, cap=1 ⇒ exp = min(1, 1*1) = 1 ⇒ [0, 1) ⇒ always 0
    for (let i = 0; i < 50; i++) {
      expect(backoffDelay(0, 1, 1)).toBe(0)
    }
  })
  it('grows with attempt until cap', () => {
    // base=100, cap=400 ⇒ attempts: [0..100), [0..200), [0..400), [0..400)
    for (let attempt = 0; attempt < 10; attempt++) {
      const d = backoffDelay(attempt, 100, 400)
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThanOrEqual(400)
    }
  })
  it('respects cap even at high attempts', () => {
    for (let i = 0; i < 100; i++) {
      const d = backoffDelay(20, 100, 400)
      expect(d).toBeLessThanOrEqual(400)
    }
  })
})



// ─────────────────────────────────────────────────────────────────
// Breadcrumbs — useWebSocket should record lifecycle events so that
// an error report submitted later carries useful trail context.
// ─────────────────────────────────────────────────────────────────
import { getBreadcrumbs, __resetErrorReporterForTests } from '../lib/errorReporter'

describe('breadcrumbs', () => {
  beforeEach(() => {
    __resetErrorReporterForTests()
    MockWebSocket.reset()
  })

  it('records an info breadcrumb when the socket opens', () => {
    const { result } = renderHook(() => useWebSocket({ baseBackoffMs: 5, maxBackoffMs: 5 }))
    act(() => result.current.connect())
    expect(MockWebSocket.instances).toHaveLength(1)
    act(() => MockWebSocket.instances[0]._open())
    const msgs = getBreadcrumbs().map((b) => b.message)
    expect(msgs.some((m) => m.startsWith('WebSocket open:'))).toBe(true)
  })

  it('records an info breadcrumb on a clean close', () => {
    const { result } = renderHook(() => useWebSocket({ baseBackoffMs: 5, maxBackoffMs: 5 }))
    act(() => result.current.connect())
    act(() => MockWebSocket.instances[0]._open())
    act(() => MockWebSocket.instances[0]._close())
    const msgs = getBreadcrumbs().map((b) => b.message)
    expect(msgs.some((m) => m.startsWith('WebSocket closed:'))).toBe(true)
  })

  it('records an error breadcrumb when reconnect cap is reached', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() =>
      useWebSocket({ maxReconnectAttempts: 1, baseBackoffMs: 1, maxBackoffMs: 2 }),
    )
    act(() => result.current.connect())
    const sock1 = MockWebSocket.instances[0]
    act(() => sock1._close()) // attempts=0, NOT at cap, will reconnect
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5)
    })
    // Second instance should now exist; close it to hit cap
    const sock2 = MockWebSocket.instances[1]
    expect(sock2).toBeDefined()
    act(() => sock2._close()) // attempts=1, at cap -> closed + error breadcrumb
    const msgs = getBreadcrumbs().map((b) => b.message)
    expect(msgs.some((m) => m.includes('gave up'))).toBe(true)
  })
})
