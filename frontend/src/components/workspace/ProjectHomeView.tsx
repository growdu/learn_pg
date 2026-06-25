import { useState, useMemo } from 'react'
import type { WorkspaceProject } from '../../types/workspace'

interface Props {
  projects: WorkspaceProject[]
  selectedProjectId: string
  onSelectProject: (id: string) => void
  onCreateProject: () => void
  onOpenTemplateDialog: () => void
  onRemoveProject: (id: string) => void
  onUpdateProject: (projectId: string, patch: { name?: string }) => void
  onNavigateToCluster: (projectId: string, clusterId: string) => void
  onCreateCluster: (projectId: string) => void
  onCreateComponent: (projectId: string) => void
}

export default function ProjectHomeView({
  projects,
  selectedProjectId,
  onSelectProject,
  onCreateProject,
  onOpenTemplateDialog,
  onRemoveProject,
  onUpdateProject,
  onNavigateToCluster,
  onCreateCluster,
  onCreateComponent,
}: Props) {
  const [editingProjectId, setEditingProjectId] = useState('')
  const [editingProjectName, setEditingProjectName] = useState('')

  const startEditProject = (project: WorkspaceProject) => {
    setEditingProjectId(project.id)
    setEditingProjectName(project.name)
  }

  const saveEditProject = () => {
    if (!editingProjectId) return
    onUpdateProject(editingProjectId, { name: editingProjectName })
    setEditingProjectId('')
  }

  const cancelEditProject = () => {
    setEditingProjectId('')
  }

  const selected = projects.find((p) => p.id === selectedProjectId) ?? projects[0]

  const getProjectStats = useMemo(() => (project: WorkspaceProject) => {
    const clusterCount = project.clusters.length
    const nodeCount = project.clusters.reduce((acc, c) => acc + c.nodes.length, 0)
    const componentCount = project.components.length
    const primaryCount = project.clusters.reduce((acc, c) => acc + c.nodes.filter((n) => n.role === 'primary').length, 0)
    const standbyCount = nodeCount - primaryCount
    return { clusterCount, nodeCount, componentCount, primaryCount, standbyCount }
  }, [])

  const totalStats = useMemo(() => ({
    projects: projects.length,
    clusters: projects.reduce((acc, p) => acc + p.clusters.length, 0),
    nodes: projects.reduce((acc, p) => acc + p.clusters.reduce((a, c) => a + c.nodes.length, 0), 0),
    components: projects.reduce((acc, p) => acc + p.components.length, 0),
  }), [projects])

  return (
    <div className="page-container">
      {/* Header */}
      <div className="page-header">
        <div>
          <h2 className="section-title" style={{ margin: 0 }}>项目总览</h2>
          <p className="section-subtitle">管理所有项目、集群和组件</p>
        </div>
        <div className="flex gap-sm">
          <button className="btn" onClick={onOpenTemplateDialog}>从模板创建</button>
          <button className="btn btn-success" onClick={onCreateProject}>新建项目</button>
        </div>
      </div>

      {/* Global Stats */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-card-icon stat-card-icon-blue">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 3h18v18H3zM3 9h18M9 21V9"/>
            </svg>
          </div>
          <div className="stat-card-content">
            <div className="stat-card-value">{totalStats.projects}</div>
            <div className="stat-card-label">项目</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card-icon stat-card-icon-green">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/>
              <line x1="12" y1="8" x2="5" y2="16"/><line x1="12" y1="8" x2="19" y2="16"/>
            </svg>
          </div>
          <div className="stat-card-content">
            <div className="stat-card-value">{totalStats.clusters}</div>
            <div className="stat-card-label">集群</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card-icon stat-card-icon-purple">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
          </div>
          <div className="stat-card-content">
            <div className="stat-card-value">{totalStats.nodes}</div>
            <div className="stat-card-label">节点</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card-icon stat-card-icon-yellow">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
            </svg>
          </div>
          <div className="stat-card-content">
            <div className="stat-card-value">{totalStats.components}</div>
            <div className="stat-card-label">组件</div>
          </div>
        </div>
      </div>

      {/* Projects */}
      {projects.length === 0 ? (
        <div className="empty-state-card">
          <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.3 }}>
            <path d="M3 3h18v18H3zM3 9h18M9 21V9"/>
          </svg>
          <p className="text-muted" style={{ marginTop: '1rem' }}>暂无项目</p>
          <p className="text-xs text-muted" style={{ marginTop: '0.5rem' }}>点击上方按钮创建第一个项目</p>
        </div>
      ) : (
        <div className="cards-grid">
          {projects.map((p) => {
            const stats = getProjectStats(p)
            const isSelected = p.id === selected?.id
            const isEditing = p.id === editingProjectId
            return (
              <div
                key={p.id}
                className={`entity-card ${isSelected ? 'entity-card-selected' : ''}`}
                onClick={() => !isEditing && onSelectProject(p.id)}
              >
                {isEditing ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    <div className="input-group">
                      <label className="input-label">项目名称</label>
                      <input className="input" value={editingProjectName} onChange={(e) => setEditingProjectName(e.target.value)} autoFocus />
                    </div>
                    <div className="flex gap-sm">
                      <button className="btn btn-sm btn-success" onClick={saveEditProject}>保存</button>
                      <button className="btn btn-sm btn-ghost" onClick={cancelEditProject}>取消</button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    <div className="entity-card-header">
                      <div className="entity-card-icon entity-card-icon-blue">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M3 3h18v18H3zM3 9h18M9 21V9"/>
                        </svg>
                      </div>
                      <div className="entity-card-title">
                        <span className="entity-card-name">{p.name}</span>
                        {isSelected && <span className="badge badge-sm badge-info">已选中</span>}
                      </div>
                      <button className="btn btn-sm btn-ghost" onClick={(e) => { e.stopPropagation(); startEditProject(p); }}>编辑</button>
                      <button className="btn btn-sm btn-danger" onClick={(e) => { e.stopPropagation(); onRemoveProject(p.id); }}>删除</button>
                    </div>
                    <div className="entity-card-stats">
                      <div className="entity-stat">
                        <span className="entity-stat-value">{stats.clusterCount}</span>
                        <span className="entity-stat-label">集群</span>
                      </div>
                      <div className="entity-stat-divider" />
                      <div className="entity-stat">
                        <span className="entity-stat-value">{stats.nodeCount}</span>
                        <span className="entity-stat-label">节点</span>
                      </div>
                      <div className="entity-stat-divider" />
                      <div className="entity-stat">
                        <span className="entity-stat-value">{stats.componentCount}</span>
                        <span className="entity-stat-label">组件</span>
                      </div>
                    </div>
                    <div className="flex gap-sm" style={{ marginTop: '0.5rem' }}>
                      <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); onCreateCluster(p.id); }}>+ 集群</button>
                      <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); onCreateComponent(p.id); }}>+ 组件</button>
                    </div>
                    <div className="entity-card-section">
                      <div className="entity-card-section-title">集群</div>
                      {stats.clusterCount === 0 ? (
                        <div className="entity-card-empty">暂无集群</div>
                      ) : (
                        <div className="entity-chips">
                          {p.clusters.map((c) => (
                            <div
                              key={c.id}
                              className="entity-chip entity-chip-clickable"
                              onClick={(e) => { e.stopPropagation(); handleClusterClick(p.id, c.id); }}
                            >
                              <span className="entity-chip-name">{c.name}</span>
                              <span className={`badge badge-xs ${c.replicationType === 'physical' ? 'badge-info' : 'badge-warning'}`}>
                                {c.replicationType === 'physical' ? '物理' : '逻辑'}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="entity-card-section">
                      <div className="entity-card-section-title">组件</div>
                      {stats.componentCount === 0 ? (
                        <div className="entity-card-empty">暂无组件</div>
                      ) : (
                        <div className="entity-chips">
                          {p.components.map((comp) => (
                            <div key={comp.id} className="entity-chip">
                              <span className="entity-chip-name">{comp.name}</span>
                              <span className="badge badge-xs badge-info">{comp.componentType}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )

  function handleClusterClick(projectId: string, clusterId: string) {
    onSelectProject(projectId)
    onNavigateToCluster(projectId, clusterId)
  }
}
