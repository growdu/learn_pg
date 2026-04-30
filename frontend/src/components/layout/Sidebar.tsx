import type { CSSProperties, ReactNode } from 'react'
import type { View } from '../../App'

interface SidebarProps {
  currentView: View
  onNavigate: (view: View) => void
  projectActive: boolean
  nodeActive: boolean
  nodeLabel: string
}

export default function Sidebar({ currentView, onNavigate, projectActive, nodeActive, nodeLabel }: SidebarProps) {
  return (
    <aside style={{ width: '230px', background: 'var(--bg-secondary)', borderRight: '1px solid var(--border)', padding: '1rem 0', overflowY: 'auto' }}>
      <Section title="项目层">
        <NavBtn label="项目主页" active={currentView === 'project_home'} onClick={() => onNavigate('project_home')} />
        <NavBtn label="集群主页" active={currentView === 'cluster_home'} onClick={() => onNavigate('cluster_home')} disabled={!projectActive} />
        <NavBtn label="组件主页" active={currentView === 'component_home'} onClick={() => onNavigate('component_home')} disabled={!projectActive} />
      </Section>

      <div style={{ marginBottom: '0.75rem', padding: '0 1rem' }}>
        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>当前节点</div>
        <div style={{ fontSize: '0.78rem', color: nodeActive ? 'var(--green)' : 'var(--text-muted)', marginTop: '0.15rem' }}>
          {nodeActive ? nodeLabel : '未激活'}
        </div>
      </div>

      <Section title="节点层">
        <NavBtn label="节点主页" active={currentView === 'node_home'} onClick={() => onNavigate('node_home')} disabled={!nodeActive} />
        <NavBtn label="SQL 控制台" active={currentView === 'sql'} onClick={() => onNavigate('sql')} disabled={!nodeActive} />
        <NavBtn label="WAL 查看" active={currentView === 'wal'} onClick={() => onNavigate('wal')} disabled={!nodeActive} />
        <NavBtn label="CLOG 查看" active={currentView === 'clog'} onClick={() => onNavigate('clog')} disabled={!nodeActive} />
        <NavBtn label="锁等待图" active={currentView === 'lock'} onClick={() => onNavigate('lock')} disabled={!nodeActive} />
        <NavBtn label="事务状态机" active={currentView === 'xact_state'} onClick={() => onNavigate('xact_state')} disabled={!nodeActive} />
        <NavBtn label="内存结构" active={currentView === 'memory'} onClick={() => onNavigate('memory')} disabled={!nodeActive} />
      </Section>
    </aside>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: '0.75rem' }}>
      <div style={{ padding: '0.25rem 1rem', fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</div>
      {children}
    </div>
  )
}

function NavBtn({ label, active, onClick, disabled = false }: { label: string; active: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} style={navButtonStyle(active, disabled)}>
      {label}
    </button>
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

