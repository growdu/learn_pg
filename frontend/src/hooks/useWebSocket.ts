import { useEffect, useRef, useCallback } from 'react'
import { useEventStore, ProbeEvent } from '../stores/eventStore'

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3000/ws'

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const addEvent = useEventStore((s) => s.addEvent)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>()

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const ws = new WebSocket(WS_URL)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('[WS] Connected')
    }

    ws.onmessage = (evt) => {
      try {
        const event: ProbeEvent = JSON.parse(evt.data)
        addEvent(event)
      } catch {
        // ignore non-JSON messages
      }
    }

    ws.onclose = () => {
      console.log('[WS] Disconnected, reconnecting...')
      reconnectTimeoutRef.current = setTimeout(connect, 3000)
    }

    ws.onerror = () => {
      console.log('[WS] Error')
    }
  }, [addEvent])

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
    }
    wsRef.current?.close()
    wsRef.current = null
  }, [])

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data))
    }
  }, [])

  useEffect(() => {
    connect()
    return () => disconnect()
  }, [connect, disconnect])

  return { connect, disconnect, send }
}