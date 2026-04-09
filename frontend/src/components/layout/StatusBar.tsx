interface StatusBarProps {
  connected: boolean
  wsConnected: boolean
  eventCount: number
  lastEventType: string
  collectorMode: string
}

export default function StatusBar({ collectorMode, connected, eventCount, lastEventType, wsConnected }: StatusBarProps) {
  return (
    <footer style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0.5rem 1.5rem',
      background: 'var(--bg-secondary)',
      borderTop: '1px solid var(--border)',
      fontSize: '0.75rem',
      color: 'var(--text-muted)',
    }}>
      <span>PG Kernel Visualizer v0.1.0</span>
      <span>
        {connected ? 'Connected to PostgreSQL' : 'Not connected'}
        {' | '}
        {wsConnected ? 'WS live' : 'WS offline'}
        {' | '}
        events={eventCount}
        {' | '}
        mode={collectorMode}
        {lastEventType ? ` | last=${lastEventType}` : ''}
      </span>
    </footer>
  )
}
