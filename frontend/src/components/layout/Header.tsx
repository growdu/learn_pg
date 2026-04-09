interface HeaderProps {
  connected: boolean
  pgVersion: string
  wsConnected: boolean
}

export default function Header({ connected, pgVersion, wsConnected }: HeaderProps) {
  return (
    <header style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0.75rem 1.5rem',
      background: 'var(--bg-secondary)',
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <span style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--accent)' }}>
          PG Kernel Visualizer
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
        <span style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
          {pgVersion || '未连接'}
        </span>
        <span style={{
          display: 'inline-block',
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: connected ? 'var(--green)' : 'var(--red)',
        }} />
        <span style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>
          {connected ? '已连接' : '未连接'}
        </span>
        <span style={{
          display: 'inline-block',
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: wsConnected ? 'var(--accent)' : 'var(--text-muted)',
        }} />
        <span style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>
          {wsConnected ? '事件流在线' : '事件流离线'}
        </span>
      </div>
    </header>
  )
}
