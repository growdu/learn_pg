import { startTransition, useCallback, useEffect, useRef, useState } from 'react'
import { useEventStore } from '../stores/eventStore'
import type { ProbeEvent } from '../types/events'

function getDefaultWsUrl() {
  if (typeof window === 'undefined') {
    return 'ws://localhost:3000/ws'
  }

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${window.location.host}/ws`
}

const WS_URL = import.meta.env.VITE_WS_URL || getDefaultWsUrl()

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
