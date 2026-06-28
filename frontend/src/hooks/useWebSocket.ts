import { startTransition, useCallback, useEffect, useRef, useState } from 'react'
import { addBreadcrumb } from '../lib/errorReporter'
import { useEventStore } from '../stores/eventStore'
import type { ProbeEvent } from '../types/events'

/**
 * WebSocket lifecycle state. The previous hook only exposed a boolean
 * (connected / not) which forced consumers to invent ad-hoc strings
 * for "connecting" and "reconnecting". The enum is exported so the
 * StatusBar component can render an indicator that distinguishes the
 * three transitional states from steady-state open/closed.
 */
export type WebSocketStatus =
  | 'idle' // not yet started
  | 'connecting' // first connection attempt in flight
  | 'open' // handshake complete
  | 'reconnecting' // waiting between retry attempts
  | 'closed' // user-called disconnect, no auto-reconnect

export interface UseWebSocketOptions {
  /**
   * Override the WebSocket URL. Defaults to `ws(s)://<host>/ws` derived
   * from window.location so it works through any reverse proxy without
   * extra env wiring.
   */
  url?: string

  /**
   * Maximum time to wait between reconnect attempts, ms. Defaults to
   * 30s. The actual delay is full-jitter exponential backoff in
   * [0, min(cap, base * 2^attempt)].
   */
  maxBackoffMs?: number
  /** Base delay for exponential backoff, ms. Defaults to 500. */
  baseBackoffMs?: number

  /**
   * Hard cap on consecutive reconnect attempts before we give up and
   * surface a `failed` status. Defaults to 0 = unlimited. Use a
   * finite cap when the consumer needs to fall back to polling.
   */
  maxReconnectAttempts?: number

  /**
   * App-level heartbeat: the hook sends `{type:'ping', t:<ts>}` on this
   * cadence (ms). Defaults to 25s. The server isn't required to echo
   * these; the hook considers the connection dead if no message
   * (any kind) arrives within `staleAfterMs`. Set to 0 to disable.
   */
  heartbeatMs?: number
  /**
   * If no inbound message arrives within this many ms, force-close the
   * socket so the reconnect loop can start a fresh one. Defaults to
   * 90s. Browsers auto-pong to protocol pings so this is a fallback for
   * NAT/firewall paths that silently drop idle connections.
   */
  staleAfterMs?: number

  /** Optional observer hooks for telemetry. */
  onOpen?: () => void
  onClose?: (event: { code: number; reason: string; wasClean: boolean }) => void
  onError?: (message: string) => void
  onReconnectFailed?: (attempts: number) => void
}

export interface UseWebSocketReturn {
  status: WebSocketStatus
  connected: boolean
  reconnectAttempts: number
  lastError: string | null
  /** Manually trigger a connect. Resets the backoff counter. */
  connect: () => void
  /** Manually disconnect. Cancels any pending reconnect. */
  disconnect: () => void
  /** Send a JSON-serialisable payload. No-op unless status === 'open'. */
  send: (data: unknown) => void
}

// Default ping payload — server doesn't need to understand it; the
// hook only uses it to nudge any idle middlebox into passing traffic.
const HEARTBEAT_PAYLOAD = { type: 'ping' }

/**
 * Compute a full-jitter backoff delay. Drawn uniformly from
 * [0, min(cap, base * 2^attempt)] so multiple components that
 * reconnect together don't hammer the server in lock-step.
 */
export function backoffDelay(attempt: number, base: number, cap: number): number {
  const exp = Math.min(cap, base * 2 ** attempt)
  return Math.floor(Math.random() * exp)
}

/** Resolve the default WebSocket URL. */
function defaultWsUrl(): string {
  if (typeof window === 'undefined') return 'ws://localhost:3000/ws'
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${window.location.host}/ws`
}

/**
 * WebSocket connection hook with:
 *   - Exponential backoff + full-jitter for reconnect
 *   - Configurable status enum (idle/connecting/open/reconnecting/closed)
 *   - App-level heartbeat that closes the socket if it goes silent,
 *     so a half-open connection eventually gets reset rather than
 *     appearing permanently open in the UI
 *   - Clean cancellation when the consumer unmounts
 *
 * The hook's return shape is backward compatible with the previous
 * boolean `connected`, so existing call sites keep working.
 */
export function useWebSocket(options: UseWebSocketOptions = {}): UseWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attemptsRef = useRef(0)
  const shouldReconnectRef = useRef(true)
  const lastMessageAtRef = useRef(0)

  // Keep references to the latest observer callbacks so the connect
  // loop doesn't capture stale values across renders.
  const callbacksRef = useRef(options)
  callbacksRef.current = options

  const addEvent = useEventStore((s) => s.addEvent)

  const [status, setStatus] = useState<WebSocketStatus>('idle')
  const [lastError, setLastError] = useState<string | null>(null)

  const cfg = {
    url: options.url ?? defaultWsUrl(),
    baseBackoffMs: options.baseBackoffMs ?? 500,
    maxBackoffMs: options.maxBackoffMs ?? 30_000,
    maxReconnectAttempts: options.maxReconnectAttempts ?? 0,
    heartbeatMs: options.heartbeatMs ?? 25_000,
    staleAfterMs: options.staleAfterMs ?? 90_000,
  }

  const clearTimers = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current)
      heartbeatTimerRef.current = null
    }
    if (staleTimerRef.current) {
      clearTimeout(staleTimerRef.current)
      staleTimerRef.current = null
    }
  }, [])

  const armStaleTimer = useCallback(() => {
    if (cfg.staleAfterMs <= 0) return
    if (staleTimerRef.current) clearTimeout(staleTimerRef.current)
    staleTimerRef.current = setTimeout(() => {
      const ws = wsRef.current
      if (!ws) return
      // Force-close so onclose fires and the reconnect loop kicks in.
      try {
        ws.close(4000, 'stale')
      } catch {
        /* ignore */
      }
    }, cfg.staleAfterMs)
  }, [cfg.staleAfterMs])

  const connect = useCallback(() => {
    shouldReconnectRef.current = true
    if (wsRef.current) {
      const ready = wsRef.current.readyState
      if (ready === WebSocket.OPEN || ready === WebSocket.CONNECTING) return
    }
    setStatus((prev) => (prev === 'open' ? 'reconnecting' : 'connecting'))
    setLastError(null)

    let ws: WebSocket
    try {
      ws = new WebSocket(cfg.url)
    } catch (e) {
      setLastError(`WebSocket construction failed: ${(e as Error).message}`)
      scheduleReconnect()
      return
    }
    wsRef.current = ws
    lastMessageAtRef.current = Date.now()

    ws.onopen = () => {
      addBreadcrumb({
        type: 'ws',
        message: `WebSocket open: ${cfg.url}`,
        data: { url: cfg.url, attempts: attemptsRef.current },
      })
      attemptsRef.current = 0
      setStatus('open')
      setLastError(null)
      callbacksRef.current.onOpen?.()
      // Start heartbeats + stale detection.
      if (cfg.heartbeatMs > 0) {
        heartbeatTimerRef.current = setInterval(() => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            try {
              wsRef.current.send(JSON.stringify(HEARTBEAT_PAYLOAD))
            } catch {
              /* ignore — onclose will follow */
            }
          }
        }, cfg.heartbeatMs)
      }
      armStaleTimer()
    }

    ws.onmessage = (evt) => {
      lastMessageAtRef.current = Date.now()
      armStaleTimer()
      try {
        const event: ProbeEvent = JSON.parse(evt.data)
        // Server pings (if it sends any at the app level) carry no payload.
        if (event && (event as { type?: string }).type === 'ping') return
        startTransition(() => {
          addEvent(event)
        })
      } catch {
        // ignore non-JSON messages
      }
    }

    ws.onclose = (evt) => {
      const atCap =
        cfg.maxReconnectAttempts > 0 && attemptsRef.current >= cfg.maxReconnectAttempts
      addBreadcrumb({
        type: 'ws',
        level: atCap && !evt.wasClean ? 'error' : 'info',
        message: atCap
          ? `WebSocket gave up after ${attemptsRef.current} attempts: ${cfg.url} (code=${evt.code})`
          : `WebSocket closed: ${cfg.url} (code=${evt.code}, clean=${evt.wasClean})`,
        data: {
          url: cfg.url,
          code: evt.code,
          reason: evt.reason,
          wasClean: evt.wasClean,
          attempts: attemptsRef.current,
          atCap,
        },
      })
      callbacksRef.current.onClose?.({
        code: evt.code,
        reason: evt.reason,
        wasClean: evt.wasClean,
      })
      // Drop references so the next connect() creates a fresh socket.
      wsRef.current = null
      clearTimers()
      // Decide whether to reconnect. We always surface the failure
      // callback (and the closed status) when the attempt cap has
      // been reached; otherwise we schedule another attempt.
      if (!shouldReconnectRef.current || atCap) {
        if (atCap) callbacksRef.current.onReconnectFailed?.(attemptsRef.current)
        setStatus('closed')
        return
      }
      setStatus('reconnecting')
      scheduleReconnect()
    }

    ws.onerror = () => {
      const msg = 'WebSocket connection error'
      addBreadcrumb({
        type: 'ws',
        level: 'error',
        message: `WebSocket error: ${cfg.url}`,
        data: { url: cfg.url, attempts: attemptsRef.current },
      })
      setLastError(msg)
      callbacksRef.current.onError?.(msg)
      // Don't change status here; onclose will follow with the
      // canonical reconnect decision.
    }
  }, [cfg.url, cfg.heartbeatMs, addEvent, armStaleTimer, clearTimers, options])

  const scheduleReconnect = useCallback(() => {
    if (!shouldReconnectRef.current) return
    attemptsRef.current += 1
    const delay = backoffDelay(attemptsRef.current - 1, cfg.baseBackoffMs, cfg.maxBackoffMs)
    reconnectTimerRef.current = setTimeout(connect, delay)
  }, [
    cfg.baseBackoffMs,
    cfg.maxBackoffMs,
    cfg.maxReconnectAttempts,
    connect,
    options,
  ])

  const disconnect = useCallback(() => {
    shouldReconnectRef.current = false
    clearTimers()
    setStatus('closed')
    setLastError(null)
    if (wsRef.current) {
      try {
        wsRef.current.close(1000, 'client disconnect')
      } catch {
        /* ignore */
      }
      wsRef.current = null
    }
  }, [clearTimers])

  const send = useCallback((data: unknown) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      try {
        ws.send(typeof data === 'string' ? data : JSON.stringify(data))
      } catch (e) {
        setLastError(`send failed: ${(e as Error).message}`)
      }
    }
  }, [])

  // Lifecycle: connect on mount, disconnect on unmount.
  useEffect(() => {
    shouldReconnectRef.current = true
    attemptsRef.current = 0
    connect()
    return () => disconnect()
    // connect/disconnect are stable; we intentionally only run this on
    // mount/unmount. Re-running it on every options change would cause
    // a reconnect storm in dev mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    status,
    connected: status === 'open',
    reconnectAttempts: attemptsRef.current,
    lastError,
    connect,
    disconnect,
    send,
  }
}
