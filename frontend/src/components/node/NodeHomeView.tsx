import { useState } from 'react'
import type { View } from '../../App'
import type { ClusterNodeStatus } from '../../types/cluster'
import { usePGStore } from '../../stores/pgStore'

interface NodeHomeViewProps {
  onNavigate: (view: View) => void
  nodeLabel: string
  selectedNodeConfig: { id: string; name: string; role: string; cluster_type: string; source?: string } | null
  nodeStatuses: ClusterNodeStatus[]
  onUpdateNode: (nodeId: string, patch: { name?: string; host?: string; port?: number; user?: string; password?: string; database?: string; role?: string }) => void
}

const modules: { view: View; title: string; desc: string; iconPath: string }[] = [
  { view: 'sql', title: 'SQL 控制台', desc: '执行 SQL，查看结果与耗时', iconPath: 'M4 17l6-6-6-6M12 19V5' },
  { view: 'wal', title: 'WAL 查看', desc: 'WAL 记录、LSN 位点与复制信息', iconPath: 'M4 19l6-6 6 6M4 13l6-6 6 6' },
  { view: 'clog', title: 'CLOG 查看', desc: '事务提交/回滚状态与细节', iconPath: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
  { view: 'write', title: '写入链路', desc: '写入路径各阶段状态与耗时', iconPath: 'M5 12h14M12 5l7 7-7 7' },
  { view: 'read', title: '读取链路', desc: '读取路径阶段状态与事件明细', iconPath: 'M3 12h18M3 6h12M3 18h6' },
  { view: 'transaction', title: '事务链路', desc: '事务执行链路阶段与关键细节', iconPath: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01' },
  { view: 'buffer', title: 'Buffer 热图', desc: 'Buffer 命中、脏页与 pinned 分布', iconPath: 'M4 4h16v16H4zM4 12h16M12 4v16' },
  { view: 'lock', title: '锁等待图', desc: '锁等待关系、阻塞链路与热点', iconPath: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14v-4m0-4h.01' },
  { view: 'xact_state', title: '事务状态机', desc: '事务状态流转与关键阶段', iconPath: 'M4 4h16v16H4zM9 9h6v6H9z' },
  { view: 'memory', title: '内存结构', desc: 'PGPROC / PGXACT / BufferDesc 结构', iconPath: 'M9 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V9M9 3v6m0 0h6' },
  { view: 'plan', title: '执行计划树', desc: 'EXPLAIN 计划树结构与成本', iconPath: 'M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v6m0 0v4m0-4h6m0 4v4m0 0h4a2 2 0 002-2V9a2 2 0 00-2-2h-4' },
]

export default function NodeHomeView({
  onNavigate,
  nodeLabel,
  selectedNodeConfig,
  nodeStatuses,
  onUpdateNode,
}: NodeHomeViewProps) {
  const connected = usePGStore((s) => s.connected)
  const version = usePGStore((s) => s.version)
  const config = usePGStore((s) => s.config)

  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editHost, setEditHost] = useState('')
  const [editPort, setEditPort] = useState(5432)
  const [editUser, setEditUser] = useState('')
  const [editPassword, setEditPassword] = useState('')
  const [editDatabase, setEditDatabase] = useState('')
  const [editRole, setEditRole] = useState('')

  const nodeStatus = nodeStatuses.find((s) => s.host === config.host && s.port === config.port)

  const startEdit = () => {
    if (!selectedNodeConfig) return
    setEditName(selectedNodeConfig.name)
    setEditHost(config.host)
    setEditPort(config.port)
    setEditUser(config.user)
    setEditPassword(config.password)
    setEditDatabase(config.database)
    setEditRole(selectedNodeConfig.role)
    setIsEditing(true)
  }

  const saveEdit = () => {
    if (!selectedNodeConfig) return
    onUpdateNode(selectedNodeConfig.id, {
      name: editName,
      host: editHost,
      port: editPort,
      user: editUser,
      password: editPassword,
      database: editDatabase,
      role: editRole,
    })
    setIsEditing(false)
  }

  const cancelEdit = () => {
    setIsEditing(false)
  }

  return (
    <div className="page-container">
      {/* Header */}
      <div className="page-header">
        <div>
          <h2 className="section-title" style={{ margin: 0 }}>{selectedNodeConfig?.name ?? '节点总览'}</h2>
          <p className="section-subtitle">{nodeLabel}</p>
        </div>
        {!isEditing && selectedNodeConfig && (
          <button className="btn" onClick={startEdit}>编辑节点</button>
        )}
      </div>

      {/* Node Health Stats */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-card-icon stat-card-icon-green">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              {connected
                ? <path d="M9 12l2 2 4-4" />
                : <path d="M15 9l-6 6M9 9l6 6" />}
            </svg>
          </div>
          <div className="stat-card-content">
            <div className="stat-card-value" style={{ color: connected ? 'var(--green)' : 'var(--red)' }}>
              {connected ? '在线' : '离线'}
            </div>
            <div className="stat-card-label">连接状态</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card-icon stat-card-icon-blue">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
          </div>
          <div className="stat-card-content">
            <div className="stat-card-value">{version || '-'}</div>
            <div className="stat-card-label">版本</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card-icon stat-card-icon-purple">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          </div>
          <div className="stat-card-content">
            <div className="stat-card-value">{selectedNodeConfig?.role ?? '-'}</div>
            <div className="stat-card-label">角色</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card-icon stat-card-icon-yellow">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-6.22-8.56" />
            </svg>
          </div>
          <div className="stat-card-content">
            <div className="stat-card-value">{selectedNodeConfig?.cluster_type === 'physical' ? '物理' : '逻辑'}</div>
            <div className="stat-card-label">复制类型</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card-icon stat-card-icon-blue">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
            </svg>
          </div>
          <div className="stat-card-content">
            <div className="stat-card-value" style={{ fontSize: '1rem' }}>{nodeStatus?.in_recovery ? '恢复中' : '正常'}</div>
            <div className="stat-card-label">恢复状态</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card-icon stat-card-icon-green">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 19l6-6 6 6M4 13l6-6 6 6" />
            </svg>
          </div>
          <div className="stat-card-content">
            <div className="stat-card-value" style={{ fontSize: '0.875rem' }}>{nodeStatus?.current_lsn ?? '-'}</div>
            <div className="stat-card-label">当前 LSN</div>
          </div>
        </div>
      </div>

      {/* Node Info */}
      <div className="cards-grid" style={{ marginBottom: '1.5rem' }}>
        <div className="entity-card">
          {isEditing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div className="input-group">
                <label className="input-label">节点名称</label>
                <input className="input" value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus />
              </div>
              <div className="input-row">
                <div className="input-group" style={{ flex: 2 }}>
                  <label className="input-label">主机</label>
                  <input className="input" value={editHost} onChange={(e) => setEditHost(e.target.value)} />
                </div>
                <div className="input-group" style={{ flex: 1 }}>
                  <label className="input-label">端口</label>
                  <input className="input" type="number" value={editPort} onChange={(e) => setEditPort(Number(e.target.value))} />
                </div>
              </div>
              <div className="input-row">
                <div className="input-group" style={{ flex: 1 }}>
                  <label className="input-label">用户</label>
                  <input className="input" value={editUser} onChange={(e) => setEditUser(e.target.value)} />
                </div>
                <div className="input-group" style={{ flex: 1 }}>
                  <label className="input-label">密码</label>
                  <input className="input" type="password" value={editPassword} onChange={(e) => setEditPassword(e.target.value)} />
                </div>
              </div>
              <div className="input-row">
                <div className="input-group" style={{ flex: 1 }}>
                  <label className="input-label">数据库</label>
                  <input className="input" value={editDatabase} onChange={(e) => setEditDatabase(e.target.value)} />
                </div>
                <div className="input-group" style={{ flex: 1 }}>
                  <label className="input-label">角色</label>
                  <select className="input" value={editRole} onChange={(e) => setEditRole(e.target.value)}>
                    <option value="primary">Primary</option>
                    <option value="standby">Standby</option>
                    <option value="publisher">Publisher</option>
                    <option value="subscriber">Subscriber</option>
                  </select>
                </div>
              </div>
              <div className="flex gap-sm">
                <button className="btn btn-sm btn-success" onClick={saveEdit}>保存</button>
                <button className="btn btn-sm btn-ghost" onClick={cancelEdit}>取消</button>
              </div>
            </div>
          ) : (
            <>
              <div className="entity-card-header">
                <div className="entity-card-icon entity-card-icon-blue">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
                  </svg>
                </div>
                <div className="entity-card-title">
                  <span className="entity-card-name">{config.host}:{config.port}</span>
                  <span className="badge badge-info">{config.database}</span>
                </div>
              </div>
              <div className="entity-card-stats">
                <div className="entity-stat">
                  <span className="entity-stat-value">{config.user}</span>
                  <span className="entity-stat-label">用户</span>
                </div>
                <div className="entity-stat-divider" />
                <div className="entity-stat">
                  <span className="entity-stat-value">{nodeStatus?.logical_slots ?? '-'}</span>
                  <span className="entity-stat-label">逻辑槽</span>
                </div>
                <div className="entity-stat-divider" />
                <div className="entity-stat">
                  <span className="entity-stat-value">{nodeStatus?.publications ?? '-'}</span>
                  <span className="entity-stat-label">发布</span>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Modules Grid */}
      <div className="cards-grid">
        {modules.map((m) => (
          <button
            key={m.view}
            className="module-card"
            onClick={() => onNavigate(m.view)}
          >
            <div className="module-card-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d={m.iconPath} />
              </svg>
            </div>
            <div className="module-card-title">{m.title}</div>
            <div className="module-card-desc">{m.desc}</div>
          </button>
        ))}
      </div>
    </div>
  )
}