import type { View } from '../../App'
import type { CSSProperties } from 'react'

interface SidebarProps {
  currentView: View
  onNavigate: (view: View) => void
  nodeActive: boolean
  nodeLabel: string
}

const clusterNavItems: { key: View; label: string }[] = [
  { key: 'cluster', label: '集群主页' },
]

const nodeGroups: { title: string; items: { key: View; label: string }[] }[] = [
  {
    title: '节点核心观测',
    items: [
      { key: 'node_home', label: '节点主页' },
      { key: 'sql', label: 'SQL 控制台' },
      { key: 'wal', label: 'WAL 查看' },
      { key: 'clog', label: 'CLOG 查看' },
      { key: 'lock', label: '锁等待图' },
      { key: 'xact_state', label: '事务状态机' },
      { key: 'memory', label: '内存结构' },
    ],
  },
  {
    title: '节点流水线',
    items: [
      { key: 'write', label: '写入流水线' },
      { key: 'read', label: '读取流水线' },
      { key: 'transaction', label: '事务流水线' },
      { key: 'plan', label: '执行计划树' },
      { key: 'buffer', label: 'Buffer 热图' },
    ],
  },
]

export default function Sidebar({ currentView, onNavigate, nodeActive, nodeLabel }: SidebarProps) {

  return (
    <aside style={{
      width: '220px',
      background: 'var(--bg-secondary)',
      borderRight: '1px solid var(--border)',
      padding: '1rem 0',
      overflowY: 'auto',
    }}>
      <div style={{ marginBottom: '0.75rem' }}>
        <div style={{ padding: '0.25rem 1rem', fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          集群
        </div>
        {clusterNavItems.map((item) => (
          <button key={item.key} onClick={() => onNavigate(item.key)} style={navButtonStyle(currentView === item.key)}>
            {item.label}
          </button>
        ))}
      </div>

      <div style={{ marginBottom: '0.75rem', padding: '0 1rem' }}>
        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>当前节点</div>
        <div style={{ fontSize: '0.78rem', color: nodeActive ? 'var(--green)' : 'var(--text-muted)', marginTop: '0.15rem' }}>
          {nodeActive ? nodeLabel : '未选择'}
        </div>
      </div>

      {nodeGroups.map((group) => (
        <div key={group.title} style={{ marginBottom: '0.75rem' }}>
          <div style={{ padding: '0.25rem 1rem', fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {group.title}
          </div>
          {group.items.map((item) => (
            <button
              key={item.key}
              onClick={() => onNavigate(item.key)}
              disabled={!nodeActive}
              style={navButtonStyle(currentView === item.key, !nodeActive)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ))}
    </aside>
  )
}

function navButtonStyle(active: boolean, disabled = false): CSSProperties {
  return {
    display: 'block',
    width: '100%',
    padding: '0.5rem 1rem',
    textAlign: 'left',
    background: active ? 'var(--bg-tertiary)' : 'transparent',
    color: disabled ? 'var(--text-muted)' : active ? 'var(--accent)' : 'var(--text)',
    border: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: '0.875rem',
    borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent',
    opacity: disabled ? 0.6 : 1,
  }
}
