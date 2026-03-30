interface StatusBarProps {
  connected: boolean
}

export default function StatusBar({ connected }: StatusBarProps) {
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
      <span>{connected ? 'Connected to PostgreSQL' : 'Not connected'}</span>
    </footer>
  )
}