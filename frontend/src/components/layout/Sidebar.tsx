type View = 'home' | 'write' | 'read' | 'transaction' | 'wal' | 'clog' | 'buffer' | 'lock' | 'memory'

interface SidebarProps {
  currentView: View
  onNavigate: (view: View) => void
}

const navItems: { key: View; label: string; group: string }[] = [
  { key: 'home', label: '首页', group: '首页' },
  { key: 'write', label: '写入 Pipeline', group: 'Pipeline' },
  { key: 'read', label: '读取 Pipeline', group: 'Pipeline' },
  { key: 'transaction', label: '事务状态', group: 'Pipeline' },
  { key: 'wal', label: 'WAL 查看器', group: '专题' },
  { key: 'clog', label: 'CLOG 查看器', group: '专题' },
  { key: 'buffer', label: 'Buffer 热图', group: '内存' },
  { key: 'lock', label: '锁等待图', group: '内存' },
  { key: 'memory', label: '内存结构', group: '内存' },
]

export default function Sidebar({ currentView, onNavigate }: SidebarProps) {
  const groups = ['首页', 'Pipeline', '专题', '内存']

  return (
    <aside style={{
      width: '200px',
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