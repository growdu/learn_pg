import type { View } from '../../App'

interface SidebarProps {
  currentView: View
  onNavigate: (view: View) => void
}

const navItems: { key: View; label: string; group: string }[] = [
  { key: 'home', label: 'Home', group: 'Overview' },
  { key: 'cluster', label: 'Cluster', group: 'Overview' },
  { key: 'write', label: 'Write Pipeline', group: 'Pipeline' },
  { key: 'read', label: 'Read Pipeline', group: 'Pipeline' },
  { key: 'transaction', label: 'Transaction Pipeline', group: 'Pipeline' },
  { key: 'xact_state', label: 'Transaction State', group: 'Pipeline' },
  { key: 'plan', label: 'Plan Tree', group: 'Pipeline' },
  { key: 'wal', label: 'WAL Viewer', group: 'Topics' },
  { key: 'clog', label: 'CLOG Viewer', group: 'Topics' },
  { key: 'buffer', label: 'Buffer Heatmap', group: 'Memory' },
  { key: 'lock', label: 'Lock Graph', group: 'Memory' },
  { key: 'memory', label: 'Memory Struct', group: 'Memory' },
]

export default function Sidebar({ currentView, onNavigate }: SidebarProps) {
  const groups = ['Overview', 'Pipeline', 'Topics', 'Memory']

  return (
    <aside style={{
      width: '220px',
      background: 'var(--bg-secondary)',
      borderRight: '1px solid var(--border)',
      padding: '1rem 0',
      overflowY: 'auto',
    }}>
      {groups.map((group) => (
        <div key={group} style={{ marginBottom: '1rem' }}>
          <div style={{
            padding: '0.25rem 1rem',
            fontSize: '0.75rem',
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}>
            {group}
          </div>
          {navItems.filter((item) => item.group === group).map((item) => (
            <button
              key={item.key}
              onClick={() => onNavigate(item.key)}
              style={{
                display: 'block',
                width: '100%',
                padding: '0.5rem 1rem',
                textAlign: 'left',
                background: currentView === item.key ? 'var(--bg-tertiary)' : 'transparent',
                color: currentView === item.key ? 'var(--accent)' : 'var(--text)',
                border: 'none',
                cursor: 'pointer',
                fontSize: '0.875rem',
                borderLeft: currentView === item.key ? '2px solid var(--accent)' : '2px solid transparent',
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ))}
    </aside>
  )
}
