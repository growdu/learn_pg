import { startTransition, useCallback, useEffect, useRef, useState } from 'react'
import { useEventStore } from '../stores/eventStore'
import type { ProbeEvent } from '../types/events'

// In Docker: VITE_WS_URL=ws://localhost/ws/ so we can't rely on it.
// Always use relative URL that goes through the reverse proxy.
function buildWsUrl() {
  if (typeof window === 'undefined') {
    return 'ws://localhost:3000/ws'
  }
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${window.location.host}/ws`
}

// In Docker, VITE_WS_URL=ws://localhost/ws/ is wrong for reverse-proxy deployments.
// The only reliable approach is to always derive from window.location.
const WS_URL = buildWsUrl()

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const addEvent = useEventStore((s) => s.addEvent)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>()
  const shouldReconnectRef = useRef(true)
  const [connected, setConnected] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const ws = new WebSocket(WS_URL)
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      setLastError(null)
      console.log('[WS] Connected')
    }

    ws.onmessage = (evt) => {
      try {
        const event: ProbeEvent = JSON.parse(evt.data)
        startTransition(() => {
          addEvent(event)
        })
      } catch {
        // ignore non-JSON messages
      }
    }

    ws.onclose = () => {
      setConnected(false)
      console.log('[WS] Disconnected, reconnecting...')
      if (shouldReconnectRef.current) {
        reconnectTimeoutRef.current = setTimeout(connect, 3000)
      }
    }

    ws.onerror = () => {
      setLastError('WebSocket connection error')
      console.log('[WS] Error')
    }
  }, [addEvent])

  const disconnect = useCallback(() => {
    shouldReconnectRef.current = false
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
    }
    setConnected(false)
    wsRef.current?.close()
    wsRef.current = null
  }, [])

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data))
    }
  }, [])

  useEffect(() => {
    shouldReconnectRef.current = true
    connect()
    return () => disconnect()
  }, [connect, disconnect])

  return { connect, connected, disconnect, lastError, send }
}
