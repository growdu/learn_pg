import { useEffect, useMemo, useState } from 'react'
import { usePGStore } from '../../stores/pgStore'
import type { View } from '../../App'
import type { WorkspaceProject } from '../../types/workspace'
import type { ClusterNodeConfig, ClusterNodeStatus, ClusterOverviewResponse, ReplicationChannel } from '../../types/cluster'

interface Props {
  project: WorkspaceProject | undefined
  selectedClusterId: string
  selectedNodeId: string
  onSelectCluster: (id: string) => void
  onCreateCluster: () => void
  onRemoveCluster: (id: string) => void
  onUpdateClusterNode: (clusterId: string, nodeId: string, patch: Partial<ClusterNodeConfig & { name?: string; alertThresholdSec?: number }>) => void
  onAddNode: (clusterId: string) => void
  onRemoveNode: (clusterId: string, nodeId: string) => void
  onNavigate: (view: View) => void
  onReloadWorkspace: () => Promise<boolean>
  onActivateNode: (clusterId: string, nodeId: string) => void
  onNodeDoubleClick: (node: ClusterNodeConfig) => void
}

interface OverviewState {
  loading: boolean
  error: string
  nodes: ClusterNodeStatus[]
  timestamp: number
}

interface EdgeInfo {
  from: string
  to: string
  label: string
}

interface DiscoveredInstance {
  host: string
  port: number
  version?: string
  service?: string
  confidence?: string
}

interface ReplicationStatus {
  primaryConnected: boolean
  secondaryConnected: boolean
  replicationWorking: boolean
  lag: string
  lastHeartbeat: number
}

interface ReplicationCluster {
  id: string
  name: string
  type: 'physical' | 'logical'
  primary: { id: string; name: string; host: string; port: number }
  secondary: { id: string; name: string; host: string; port: number }
  replicationStatus: ReplicationStatus
  createdAt: number
}

export default function ClusterHomeView(props: Props) {
  const {} = usePGStore()
  const [overview, setOverview] = useState<OverviewState>({ loading: false, error: '', nodes: [], timestamp: 0 })
  const [selectedEdgeKey, setSelectedEdgeKey] = useState('')
  const [selectedNodeId, setSelectedNodeId] = useState('')
  const [activeTab, setActiveTab] = useState<'topology' | 'nodes' | 'add'>('topology')
  const [sourceFilter, setSourceFilter] = useState<'all' | 'provisioned' | 'discovered' | 'dsn' | 'manual'>('all')
  const [scanHost, setScanHost] = useState('127.0.0.1')
  const [scanPort, setScanPort] = useState(5432)
  const [scanLoading, setScanLoading] = useState(false)
  const [scanError, setScanError] = useState('')
  const [instances, setInstances] = useState<DiscoveredInstance[]>([])
  const [dsn, setDsn] = useState('')
  const [dsnLoading, setDsnLoading] = useState(false)
  const [dsnMessage, setDsnMessage] = useState('')
  const [importUser, setImportUser] = useState('postgres')
  const [importDatabase, setImportDatabase] = useState('postgres')
  const [autoConnectAfterImport, setAutoConnectAfterImport] = useState(false)
  const [highlightNodeId, setHighlightNodeId] = useState('')
  const [importLogs, setImportLogs] = useState<Array<{ ts: number; level: string; message: string }>>([])
  const [editingClusterId, setEditingClusterId] = useState('')
  const [editingClusterName, setEditingClusterName] = useState('')
  const [editingClusterThreshold, setEditingClusterThreshold] = useState(30)
  const [editingNodeId, setEditingNodeId] = useState('')
  const [editingNodeData, setEditingNodeData] = useState({ name: '', host: '', port: 5432, user: '', database: '', role: 'standby' })

  const cluster = useMemo(
    () => props.project?.clusters.find((c) => c.id === props.selectedClusterId) ?? props.project?.clusters[0],
    [props.project, props.selectedClusterId],
  )

  const alertThresholdSec = cluster?.alertThresholdSec ?? 30
  const alertThresholdBytes = alertThresholdSec * 1024 * 1024

  useEffect(() => {
    let stop = false
    const loadOverview = async () => {
      if (!props.project || !cluster) {
        if (!stop) setOverview({ loading: false, error: '', nodes: [], timestamp: 0 })
        return
      }
      try {
        const res = await fetch(`/api/cluster/${cluster.id}/overview`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as ClusterOverviewResponse
        if (!data.success) throw new Error(data.error || '获取集群状态失败')
        if (!stop) setOverview({ loading: false, error: '', nodes: data.nodes || [], timestamp: data.timestamp || Date.now() })
      } catch (err) {
        if (!stop) setOverview({ loading: false, error: err instanceof Error ? err.message : '获取集群状态失败', nodes: [], timestamp: 0 })
      }
    }
    loadOverview()
    const timer = window.setInterval(loadOverview, 5000)
    return () => { stop = true; window.clearInterval(timer) }
  }, [props.project, cluster])

  const activateNode = async (node: ClusterNodeConfig, view: View) => {
    const res = await fetch(`/api/nodes/${node.id}/activate`, { method: 'POST' })
    const data = await res.json()
    if (data.success) {
      usePGStore.getState().setActiveNodeId(node.id)
      usePGStore.getState().setConnected(true)
      usePGStore.getState().setVersion(data.version || '')
      usePGStore.getState().setDataDir(data.dataDir || '')
    }
    props.onNavigate(view)
  }

  const handleNodeDoubleClick = (node: ClusterNodeConfig) => {
    if (!cluster) return
    props.onActivateNode(cluster.id, node.id)
    void activateNode(node, 'node_home')
  }

  const startEditCluster = (clusterId: string) => {
    const c = props.project?.clusters.find((x) => x.id === clusterId)
    if (!c) return
    setEditingClusterId(clusterId)
    setEditingClusterName(c.name)
    setEditingClusterThreshold(c.alertThresholdSec ?? 30)
  }

  const saveEditCluster = () => {
    if (!editingClusterId) return
    props.onUpdateClusterNode(editingClusterId, '', { name: editingClusterName, alertThresholdSec: editingClusterThreshold })
    setEditingClusterId('')
  }

  const cancelEditCluster = () => {
    setEditingClusterId('')
  }

  const startEditNode = (node: ClusterNodeConfig) => {
    setEditingNodeId(node.id)
    setEditingNodeData({ name: node.name, host: node.host, port: node.port, user: node.user, database: node.database, role: node.role })
  }

  const saveEditNode = () => {
    if (!editingNodeId || !cluster) return
    props.onUpdateClusterNode(cluster.id, editingNodeId, editingNodeData)
    setEditingNodeId('')
  }

  const cancelEditNode = () => {
    setEditingNodeId('')
  }

  const runHostScan = async () => {
    setScanLoading(true)
    setScanError('')
    addLog('info', `开始探测主机 ${scanHost.trim() || '-'}端口 ${scanPort}`)
    try {
      const res = await fetch('/api/discovery/host/scan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: scanHost.trim(), port: scanPort }),
      })
      const data = (await res.json()) as { success?: boolean; error?: string; instances?: Array<{ host: string; port: number; version?: string; confidence?: string }> }
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`)
      setInstances(data.instances ?? [])
      addLog('success', `发现 ${data.instances?.length ?? 0} 个候选实例`)
    } catch (err) {
      setScanError(err instanceof Error ? err.message : '主机探测失败')
      addLog('error', `主机探测失败：${err instanceof Error ? err.message : '未知错误'}`)
    } finally {
      setScanLoading(false)
    }
  }

  const importDiscovered = async (instance: DiscoveredInstance) => {
    if (!props.project || !cluster) return
    addLog('info', `开始导入 ${instance.host}:${instance.port}`)
    try {
      const res = await fetch('/api/discovery/host/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: props.project.id, clusterId: cluster.id, instance,
          autoConnect: autoConnectAfterImport, user: importUser, database: importDatabase,
        }),
      })
      const data = (await res.json()) as { success?: boolean; error?: string; nodeId?: string }
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`)
      await props.onReloadWorkspace()
      addLog('success', `导入成功 ${instance.host}:${instance.port}`)
      if (data.nodeId) setHighlightNodeId(data.nodeId)
    } catch (err) {
      setScanError(err instanceof Error ? err.message : '导入失败')
      addLog('error', `导入失败：${err instanceof Error ? err.message : '未知错误'}`)
    }
  }

  const validateAndImportDSN = async () => {
    if (!props.project || !cluster || !dsn.trim()) return
    setDsnLoading(true)
    setDsnMessage('')
    try {
      addLog('info', '校验 DSN')
      const valRes = await fetch('/api/discovery/dsn/validate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dsn: dsn.trim() }),
      })
      const valData = (await valRes.json()) as { success?: boolean; reachable?: boolean; version?: string; error?: string }
      if (!valRes.ok || !valData.success || !valData.reachable) throw new Error(valData.error || 'DSN 校验失败')
      addLog('success', `DSN 校验通过，版本 ${valData.version || '-'}`)
      const impRes = await fetch('/api/discovery/dsn/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: props.project.id, clusterId: cluster.id, dsn: dsn.trim(), autoConnect: autoConnectAfterImport }),
      })
      const impData = (await impRes.json()) as { success?: boolean; error?: string; nodeId?: string }
      if (!impRes.ok || !impData.success) throw new Error(impData.error || 'DSN 导入失败')
      setDsnMessage(`导入成功，版本 ${valData.version || '-'}`)
      await props.onReloadWorkspace()
      addLog('success', 'DSN 导入成功')
      if (impData.nodeId) setHighlightNodeId(impData.nodeId)
    } catch (err) {
      setDsnMessage(err instanceof Error ? err.message : 'DSN 导入失败')
      addLog('error', `导入失败：${err instanceof Error ? err.message : '未知错误'}`)
    } finally {
      setDsnLoading(false)
    }
  }

  useEffect(() => {
    if (!highlightNodeId) return
    const timer = window.setTimeout(() => {
      const el = document.querySelector(`[data-node-id="${highlightNodeId}"]`) as HTMLElement | null
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 120)
    const clear = window.setTimeout(() => setHighlightNodeId(''), 3500)
    return () => { window.clearTimeout(timer); window.clearTimeout(clear) }
  }, [highlightNodeId])

  const clusterStatuses = useMemo(() => {
    if (!cluster) return []
    const ids = new Set(cluster.nodes.map((n) => n.id))
    return overview.nodes.filter((n) => ids.has(n.id))
  }, [cluster, overview.nodes])

  const summary = useMemo(() => {
    const totalClusters = props.project?.clusters.length ?? 0
    const totalNodes = props.project?.clusters.reduce((acc, c) => acc + c.nodes.length, 0) ?? 0
    const connectedNodes = overview.nodes.filter((n) => n.connected).length
    const unhealthyNodes = overview.nodes.filter((n) => !n.connected).length
    const primaryCount = cluster?.nodes.filter((n) => n.role === 'primary').length ?? 0
    const standbyCount = (cluster?.nodes.length ?? 0) - primaryCount
    return { totalClusters, totalNodes, connectedNodes, unhealthyNodes, primaryCount, standbyCount }
  }, [props.project, overview.nodes, cluster])

  const topologyEdges = useMemo(() => {
    if (!cluster) return [] as EdgeInfo[]
    const nodes = cluster.nodes
    if (cluster.replicationType === 'physical') {
      const primary = nodes.find((n) => n.role === 'primary') ?? nodes[0]
      if (!primary) return []
      return nodes.filter((n) => n.id !== primary.id).map((n) => ({ from: primary.id, to: n.id, label: 'WAL' }))
    }
    const publisher = nodes.find((n) => n.role === 'publisher') ?? nodes[0]
    if (!publisher) return []
    return nodes.filter((n) => n.id !== publisher.id).map((n) => ({ from: publisher.id, to: n.id, label: 'LOGICAL' }))
  }, [cluster])

  const selectedEdgeDetail = useMemo(() => {
    if (!cluster || !selectedEdgeKey) return null
    const [fromId, toId] = selectedEdgeKey.split('->')
    const fromNode = cluster.nodes.find((n) => n.id === fromId)
    const toNode = cluster.nodes.find((n) => n.id === toId)
    if (!fromNode || !toNode) return null
    const fromStatus = clusterStatuses.find((s) => s.id === fromId)
    const toStatus = clusterStatuses.find((s) => s.id === toId)
    if (cluster.replicationType === 'physical') {
      const ch = pickChannel(fromStatus?.physical_replication, toNode.name)
      const lagBytes = ch?.lag_bytes ?? 0
      return { mode: '物理复制', from: fromNode.name, to: toNode.name, state: ch?.state || '-', syncState: ch?.sync_state || '-', lagBytes, isAlert: lagBytes >= alertThresholdBytes }
    }
    const sub = toStatus?.subscriptions?.[0]
    return { mode: '逻辑复制', from: fromNode.name, to: toNode.name, state: sub?.enabled ? 'enabled' : 'disabled', syncState: sub?.worker_type || '-', lagBytes: 0, isAlert: false }
  }, [cluster, clusterStatuses, selectedEdgeKey, alertThresholdBytes])

  const addLog = (level: string, message: string) => {
    setImportLogs((prev) => [{ ts: Date.now(), level, message }, ...prev].slice(0, 20))
  }

  const filteredNodes = useMemo(() => {
    if (!cluster) return []
    if (sourceFilter === 'all') return cluster.nodes
    return cluster.nodes.filter((n) => (n.source ?? 'manual') === sourceFilter)
  }, [cluster, sourceFilter])

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="flex items-center gap-md">
          <button className="btn btn-ghost btn-sm" onClick={() => props.onNavigate('project_home')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
            返回项目
          </button>
          <div>
            <h2 className="section-title" style={{ margin: 0 }}>{cluster?.name ?? '集群总览'}</h2>
            <p className="section-subtitle">{props.project?.name ?? ''} / 集群管理</p>
          </div>
        </div>
        <button className="btn btn-success" onClick={props.onCreateCluster}>+ 新建集群</button>
      </div>

      {/* Cluster Stats */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-card-icon stat-card-icon-blue">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/>
              <line x1="12" y1="8" x2="5" y2="16"/><line x1="12" y1="8" x2="19" y2="16"/>
            </svg>
          </div>
          <div className="stat-card-content">
            <div className="stat-card-value">{summary.totalClusters}</div>
            <div className="stat-card-label">集群</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card-icon stat-card-icon-green">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
          </div>
          <div className="stat-card-content">
            <div className="stat-card-value">{summary.totalNodes}</div>
            <div className="stat-card-label">节点</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card-icon stat-card-icon-green">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
            </svg>
          </div>
          <div className="stat-card-content">
            <div className="stat-card-value" style={{ color: 'var(--green)' }}>{summary.connectedNodes}</div>
            <div className="stat-card-label">在线</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card-icon stat-card-icon-red">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
          </div>
          <div className="stat-card-content">
            <div className="stat-card-value" style={{ color: summary.unhealthyNodes > 0 ? 'var(--red)' : 'inherit' }}>{summary.unhealthyNodes}</div>
            <div className="stat-card-label">异常</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card-icon stat-card-icon-purple">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
          </div>
          <div className="stat-card-content">
            <div className="stat-card-value">{summary.primaryCount}</div>
            <div className="stat-card-label">Primary</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card-icon stat-card-icon-yellow">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-6.22-8.56"/>
            </svg>
          </div>
          <div className="stat-card-content">
            <div className="stat-card-value">{summary.standbyCount}</div>
            <div className="stat-card-label">Standby</div>
          </div>
        </div>
      </div>

      {/* Cluster Selector */}
      {!props.project ? (
        <div className="empty-state-card">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.3 }}>
            <circle cx="12" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/>
            <line x1="12" y1="8" x2="5" y2="16"/><line x1="12" y1="8" x2="19" y2="16"/>
          </svg>
          <p className="text-muted" style={{ marginTop: '1rem' }}>请先选择项目</p>
        </div>
      ) : props.project.clusters.length === 0 ? (
        <div className="empty-state-card">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.3 }}>
            <circle cx="12" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/>
            <line x1="12" y1="8" x2="5" y2="16"/><line x1="12" y1="8" x2="19" y2="16"/>
          </svg>
          <p className="text-muted" style={{ marginTop: '1rem' }}>暂无集群</p>
          <p className="text-xs text-muted" style={{ marginTop: '0.5rem' }}>点击上方按钮创建第一个集群</p>
        </div>
      ) : (
        <>
          {/* Cluster Cards */}
          <div className="cards-grid">
            {props.project.clusters.map((c) => {
              const cids = new Set(c.nodes.map((n) => n.id))
              const online = overview.nodes.filter((n) => cids.has(n.id) && n.connected).length
              const isSelected = c.id === cluster?.id
              const isEditing = c.id === editingClusterId
              return (
                <div
                  key={c.id}
                  className={`entity-card ${isSelected ? 'entity-card-selected' : ''}`}
                  onClick={() => !isEditing && props.onSelectCluster(c.id)}
                >
                  {isEditing ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                      <div className="input-group">
                        <label className="input-label">集群名称</label>
                        <input className="input" value={editingClusterName} onChange={(e) => setEditingClusterName(e.target.value)} autoFocus />
                      </div>
                      <div className="input-group">
                        <label className="input-label">告警阈值 (秒)</label>
                        <input className="input" type="number" value={editingClusterThreshold} onChange={(e) => setEditingClusterThreshold(Number(e.target.value))} />
                      </div>
                      <div className="flex gap-sm">
                        <button className="btn btn-sm btn-success" onClick={saveEditCluster}>保存</button>
                        <button className="btn btn-sm btn-ghost" onClick={cancelEditCluster}>取消</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="entity-card-header">
                        <div className="entity-card-icon entity-card-icon-green">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="12" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/>
                            <line x1="12" y1="8" x2="5" y2="16"/><line x1="12" y1="8" x2="19" y2="16"/>
                          </svg>
                        </div>
                        <div className="entity-card-title">
                          <span className="entity-card-name">{c.name}</span>
                          <span className={`badge badge-sm ${c.replicationType === 'physical' ? 'badge-info' : 'badge-warning'}`}>
                            {c.replicationType === 'physical' ? '物理' : '逻辑'}
                          </span>
                        </div>
                        <button className="btn btn-sm btn-ghost" onClick={(e) => { e.stopPropagation(); startEditCluster(c.id); }}>编辑</button>
                        <button className="btn btn-sm btn-danger" onClick={(e) => { e.stopPropagation(); props.onRemoveCluster(c.id); }}>删除</button>
                      </div>
                      <div className="entity-card-stats">
                        <div className="entity-stat">
                          <span className="entity-stat-value">{c.nodes.length}</span>
                          <span className="entity-stat-label">节点</span>
                        </div>
                        <div className="entity-stat-divider" />
                        <div className="entity-stat">
                          <span className="entity-stat-value" style={{ color: online > 0 ? 'var(--green)' : 'inherit' }}>{online}</span>
                          <span className="entity-stat-label">在线</span>
                        </div>
                        <div className="entity-stat-divider" />
                        <div className="entity-stat">
                          <span className="entity-stat-value">{c.alertThresholdSec ?? 30}s</span>
                          <span className="entity-stat-label">告警</span>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </div>

          {/* Cluster Detail */}
          {cluster && (
            <div className="cluster-detail-section">
              <div className="cluster-detail-header">
                <h3 className="cluster-detail-title">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/>
                    <line x1="12" y1="8" x2="5" y2="16"/><line x1="12" y1="8" x2="19" y2="16"/>
                  </svg>
                  {cluster.name}
                </h3>
                <div className="cluster-detail-tabs">
                  <button className={`cluster-tab ${activeTab === 'topology' ? 'cluster-tab-active' : ''}`} onClick={() => setActiveTab('topology')}>拓扑</button>
                  <button className={`cluster-tab ${activeTab === 'nodes' ? 'cluster-tab-active' : ''}`} onClick={() => setActiveTab('nodes')}>节点 ({cluster.nodes.length})</button>
                  <button className={`cluster-tab ${activeTab === 'add' ? 'cluster-tab-active' : ''}`} onClick={() => setActiveTab('add')}>添加</button>
                </div>
              </div>

              {activeTab === 'topology' && (
                <div className="cluster-detail-content">
                  {cluster.nodes.length === 0 ? (
                    <div className="empty-state-inline">暂无节点，请先添加</div>
                  ) : (
                    <>
                      <TopologyMap
                        statuses={clusterStatuses}
                        nodes={cluster.nodes}
                        edges={topologyEdges}
                        selectedEdgeKey={selectedEdgeKey}
                        selectedNodeId={selectedNodeId}
                        onEdgeClick={(key) => { setSelectedEdgeKey(key); setSelectedNodeId(''); }}
                        onNodeClick={(nodeId) => { setSelectedNodeId(nodeId); setSelectedEdgeKey(''); }}
                        onNodeDoubleClick={(node) => handleNodeDoubleClick(node)}
                      />
                      {selectedEdgeDetail && (
                        <div className="edge-info">
                          <div className="edge-info-header">
                            <span>{selectedEdgeDetail.from} → {selectedEdgeDetail.to}</span>
                            <span className={`badge ${selectedEdgeDetail.isAlert ? 'badge-error' : 'badge-success'}`}>
                              {selectedEdgeDetail.isAlert ? '告警' : '正常'}
                            </span>
                          </div>
                          <div className="edge-info-meta">{selectedEdgeDetail.mode} · {selectedEdgeDetail.state} · {selectedEdgeDetail.syncState}</div>
                        </div>
                      )}
                      {(cluster.replicationType === 'physical' || cluster.replicationType === 'logical') && (() => {
                        const primaryNode = cluster.nodes.find((n) => n.role === 'primary') || cluster.nodes.find((n) => n.role === 'publisher') || cluster.nodes[0]
                        const secondaryNode = cluster.nodes.find((n) => n.role !== 'primary' && n.role !== 'publisher') || cluster.nodes[1]
                        if (!primaryNode || !secondaryNode) return null
                        const primaryStatus = clusterStatuses.find((s) => s.id === primaryNode.id)
                        const secondaryStatus = clusterStatuses.find((s) => s.id === secondaryNode.id)
                        const replicationCluster: ReplicationCluster = {
                          id: cluster.id,
                          name: cluster.name,
                          type: cluster.replicationType,
                          primary: { id: primaryNode.id, name: primaryNode.name, host: primaryNode.host, port: primaryNode.port },
                          secondary: { id: secondaryNode.id, name: secondaryNode.name, host: secondaryNode.host, port: secondaryNode.port },
                          replicationStatus: {
                            primaryConnected: primaryStatus?.connected ?? false,
                            secondaryConnected: secondaryStatus?.connected ?? false,
                            replicationWorking: (primaryStatus?.connected ?? false) && (secondaryStatus?.connected ?? false),
                            lag: selectedEdgeDetail ? `${(selectedEdgeDetail.lagBytes / 1024 / 1024).toFixed(2)} MB` : '0 MB',
                            lastHeartbeat: Date.now(),
                          },
                          createdAt: Date.now(),
                        }
                        return <ReplicationTopology cluster={replicationCluster} />
                      })()}
                    </>
                  )}
                </div>
              )}

              {activeTab === 'nodes' && (
                <div className="cluster-detail-content">
                  <div className="flex items-center justify-between" style={{ marginBottom: '1rem' }}>
                    <div className="flex items-center gap-sm">
                      <span className="text-sm text-muted">来源筛选：</span>
                      <select className="input" style={{ width: 'auto' }} value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value as 'all' | 'manual' | 'provisioned' | 'discovered' | 'dsn')}>
                        <option value="all">全部</option>
                        <option value="provisioned">自动拉起</option>
                        <option value="discovered">主机探测</option>
                        <option value="dsn">DSN 导入</option>
                        <option value="manual">手动配置</option>
                      </select>
                    </div>
                    <button className="btn btn-sm btn-success" onClick={() => { props.onAddNode(cluster.id); setActiveTab('add'); }}>+ 添加节点</button>
                  </div>
                  {filteredNodes.length === 0 ? (
                    <div className="empty-state-inline">暂无节点</div>
                  ) : (
                    <div className="nodes-cards-grid">
                      {filteredNodes.map((n) => {
                        const status = clusterStatuses.find((s) => s.id === n.id)
                        const isEditing = n.id === editingNodeId
                        return (
                          <div key={n.id} data-node-id={n.id} className={`node-card ${highlightNodeId === n.id ? 'node-card-highlight' : ''}`} onDoubleClick={() => !isEditing && handleNodeDoubleClick(n)}>
                            {isEditing ? (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                <div className="input-group">
                                  <label className="input-label">节点名称</label>
                                  <input className="input" value={editingNodeData.name} onChange={(e) => setEditingNodeData({ ...editingNodeData, name: e.target.value })} autoFocus />
                                </div>
                                <div className="input-row">
                                  <div className="input-group" style={{ flex: 2 }}>
                                    <label className="input-label">主机</label>
                                    <input className="input" value={editingNodeData.host} onChange={(e) => setEditingNodeData({ ...editingNodeData, host: e.target.value })} />
                                  </div>
                                  <div className="input-group" style={{ flex: 1 }}>
                                    <label className="input-label">端口</label>
                                    <input className="input" type="number" value={editingNodeData.port} onChange={(e) => setEditingNodeData({ ...editingNodeData, port: Number(e.target.value) })} />
                                  </div>
                                </div>
                                <div className="input-row">
                                  <div className="input-group" style={{ flex: 1 }}>
                                    <label className="input-label">用户</label>
                                    <input className="input" value={editingNodeData.user} onChange={(e) => setEditingNodeData({ ...editingNodeData, user: e.target.value })} />
                                  </div>
                                </div>
                                <div className="input-row">
                                  <div className="input-group" style={{ flex: 1 }}>
                                    <label className="input-label">数据库</label>
                                    <input className="input" value={editingNodeData.database} onChange={(e) => setEditingNodeData({ ...editingNodeData, database: e.target.value })} />
                                  </div>
                                  <div className="input-group" style={{ flex: 1 }}>
                                    <label className="input-label">角色</label>
                                    <select className="input" value={editingNodeData.role} onChange={(e) => setEditingNodeData({ ...editingNodeData, role: e.target.value })}>
                                      <option value="primary">Primary</option>
                                      <option value="standby">Standby</option>
                                      <option value="publisher">Publisher</option>
                                      <option value="subscriber">Subscriber</option>
                                    </select>
                                  </div>
                                </div>
                                <div className="flex gap-sm">
                                  <button className="btn btn-sm btn-success" onClick={saveEditNode}>保存</button>
                                  <button className="btn btn-sm btn-ghost" onClick={cancelEditNode}>取消</button>
                                </div>
                              </div>
                            ) : (
                              <>
                                <div className="node-card-header">
                                  <div className="node-card-status">
                                    <span className={`status-indicator ${status?.connected ? 'status-online' : 'status-offline'}`} />
                                    <span className="node-card-name">{n.name}</span>
                                  </div>
                                  <span className={`badge ${status?.connected ? 'badge-success' : 'badge-error'}`}>
                                    {status?.connected ? '在线' : '离线'}
                                  </span>
                                </div>
                                <div className="node-card-info">
                                  <div className="node-card-info-row">
                                    <span className="node-card-info-label">主机</span>
                                    <span className="node-card-info-value font-mono">{n.host}:{n.port}</span>
                                  </div>
                                  <div className="node-card-info-row">
                                    <span className="node-card-info-label">角色</span>
                                    <span className="node-card-info-value">{n.role}</span>
                                  </div>
                                  <div className="node-card-info-row">
                                    <span className="node-card-info-label">版本</span>
                                    <span className="node-card-info-value">{status?.version || '-'}</span>
                                  </div>
                                </div>
                                <div className="node-card-actions">
                                  <button className="btn btn-sm btn-ghost" onClick={() => startEditNode(n)}>编辑</button>
                                  <button className="btn btn-sm btn-success" onClick={() => activateNode(n, 'node_home')}>激活</button>
                                  <button className="btn btn-sm" onClick={() => activateNode(n, 'sql')}>SQL</button>
                                  <button className="btn btn-sm btn-danger" onClick={() => props.onRemoveNode(cluster.id, n.id)}>移除</button>
                                </div>
                              </>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'add' && (
                <div className="cluster-detail-content">
                  <div className="add-options">
                    <div className="add-option" onClick={() => props.onAddNode(cluster.id)}>
                      <div className="add-option-icon">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>
                        </svg>
                      </div>
                      <div>
                        <div className="add-option-title">快速添加节点</div>
                        <div className="add-option-desc">创建空白节点，配置连接信息后使用</div>
                      </div>
                    </div>
                    <div className="add-option">
                      <div className="add-option-icon">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                        </svg>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div className="add-option-title">主机探测导入</div>
                        <div className="add-option-desc">扫描网络发现 PostgreSQL 实例</div>
                        <div className="add-option-form">
                          <div className="form-row">
                            <input className="input" value={importUser} onChange={(e) => setImportUser(e.target.value)} placeholder="用户名" />
                            <input className="input" value={importDatabase} onChange={(e) => setImportDatabase(e.target.value)} placeholder="数据库" />
                          </div>
                          <div className="form-row">
                            <input className="input" value={scanHost} onChange={(e) => setScanHost(e.target.value)} placeholder="主机 IP" />
                            <input className="input" type="number" value={scanPort} onChange={(e) => setScanPort(Number(e.target.value))} placeholder="端口" style={{ width: '100px' }} />
                            <button className="btn" onClick={runHostScan} disabled={scanLoading}>{scanLoading ? '探测中' : '扫描'}</button>
                          </div>
                          <label className="flex items-center gap-sm text-sm">
                            <input type="checkbox" checked={autoConnectAfterImport} onChange={(e) => setAutoConnectAfterImport(e.target.checked)} />
                            导入后自动连接
                          </label>
                        </div>
                        {scanError && <div className="alert alert-error" style={{ marginTop: '0.5rem' }}>{scanError}</div>}
                        {instances.length > 0 && (
                          <div className="discovered-list">
                            {instances.map((ins, idx) => (
                              <div key={`${ins.host}:${ins.port}-${idx}`} className="discovered-item">
                                <span>
                                  {ins.host}:{ins.port}
                                  {ins.version ? ` · ${ins.version}` : ' · 不可达'}
                                  {ins.confidence === 'high' ? ' ✓' : ins.confidence === 'low' ? ' ✗' : ''}
                                </span>
                                <button className="btn btn-sm" onClick={() => importDiscovered(ins as DiscoveredInstance)}>导入</button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="add-option">
                      <div className="add-option-icon">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                        </svg>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div className="add-option-title">DSN 导入</div>
                        <div className="add-option-desc">输入连接字符串自动解析</div>
                        <input className="input font-mono" value={dsn} onChange={(e) => setDsn(e.target.value)} placeholder="postgresql://user:pass@host:5432/db" style={{ marginTop: '0.75rem' }} />
                        <button className="btn" style={{ marginTop: '0.5rem' }} onClick={validateAndImportDSN} disabled={dsnLoading}>{dsnLoading ? '处理中' : '校验并导入'}</button>
                        {dsnMessage && <div className={`alert ${dsnMessage.includes('成功') ? 'alert-success' : 'alert-error'}`} style={{ marginTop: '0.5rem' }}>{dsnMessage}</div>}
                      </div>
                    </div>
                  </div>
                  {importLogs.length > 0 && (
                    <div className="import-logs">
                      <div className="flex justify-between items-center" style={{ marginBottom: '0.5rem' }}>
                        <span className="text-sm text-muted">操作日志</span>
                        <button className="btn btn-sm btn-ghost" onClick={() => setImportLogs([])}>清空</button>
                      </div>
                      {importLogs.map((x, i) => (
                        <div key={i} className={`log-line log-${x.level}`}>
                          <span className="log-time">{new Date(x.ts).toLocaleTimeString()}</span>
                          <span>{x.message}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function pickChannel(channels: ReplicationChannel[] | undefined, nodeName: string): ReplicationChannel | undefined {
  if (!channels || channels.length === 0) return undefined
  const key = nodeName.toLowerCase()
  return channels.find((c) => c.name.toLowerCase().includes(key))
}

function ReplicationTopology({ cluster }: { cluster: ReplicationCluster }) {
  const isPhysical = cluster.type === 'physical'

  return (
    <div className="replication-topology">
      <div className="topology-diagram">
        <div className="node primary">
          <span className="node-label">Primary</span>
          <span className="node-host">{cluster.primary.host}:{cluster.primary.port}</span>
          <span className={`status-badge ${cluster.replicationStatus.primaryConnected ? 'connected' : 'disconnected'}`}>
            {cluster.replicationStatus.primaryConnected ? 'Connected' : 'Disconnected'}
          </span>
        </div>

        <div className="replication-arrow">
          {isPhysical ? (
            <span className="arrow physical">{"<"}-- replication --{">"}</span>
          ) : (
            <span className="arrow logical">{"--"}logical replication{"-"}&gt;</span>
          )}
          <span className="lag-info">LAG: {cluster.replicationStatus.lag}</span>
        </div>

        <div className="node secondary">
          <span className="node-label">{isPhysical ? 'Standby' : 'Subscriber'}</span>
          <span className="node-host">{cluster.secondary.host}:{cluster.secondary.port}</span>
          <span className={`status-badge ${cluster.replicationStatus.secondaryConnected ? 'connected' : 'disconnected'}`}>
            {cluster.replicationStatus.secondaryConnected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </div>
    </div>
  )
}

function TopologyMap({
  nodes,
  statuses,
  edges,
  selectedEdgeKey,
  selectedNodeId,
  onEdgeClick,
  onNodeClick,
  onNodeDoubleClick,
}: {
  nodes: WorkspaceProject['clusters'][number]['nodes']
  statuses: ClusterNodeStatus[]
  edges: EdgeInfo[]
  selectedEdgeKey: string
  selectedNodeId: string
  onEdgeClick: (key: string) => void
  onNodeClick: (nodeId: string) => void
  onNodeDoubleClick: (node: WorkspaceProject['clusters'][number]['nodes'][number]) => void
}) {
  const width = 700, height = 180, y = 90, nodeWidth = 120, nodeHeight = 48
  const gap = nodes.length <= 1 ? 0 : (width - 80 - nodeWidth) / Math.max(1, nodes.length - 1)
  const byId = new Map(statuses.map((s) => [s.id, s]))
  const positions = nodes.map((n, idx) => ({ id: n.id, x: 40 + idx * gap, y, node: n, status: byId.get(n.id) }))

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height}>
      <defs>
        <marker id="arrow" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L10,4 L0,8 z" fill="#94a3b8" />
        </marker>
      </defs>
      {edges.map((e) => {
        const from = positions.find((p) => p.id === e.from), to = positions.find((p) => p.id === e.to)
        if (!from || !to) return null
        const key = `${e.from}->${e.to}`, active = key === selectedEdgeKey
        const x1 = from.x + nodeWidth, y1 = from.y + nodeHeight / 2, x2 = to.x, y2 = to.y + nodeHeight / 2, mx = (x1 + x2) / 2
        return (
          <g key={key} onClick={() => onEdgeClick(key)} style={{ cursor: 'pointer' }}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={active ? '#60a5fa' : '#94a3b8'} strokeWidth={active ? 2.5 : 1.5} markerEnd="url(#arrow)" />
            <text x={mx} y={y1 - 8} textAnchor="middle" fontSize="10" fill={active ? '#60a5fa' : '#94a3b8'}>{e.label}</text>
          </g>
        )
      })}
      {positions.map((p) => {
        const ok = p.status?.connected ?? false, active = selectedNodeId === p.id
        return (
          <g key={p.id} onClick={() => onNodeClick(p.id)} onDoubleClick={() => onNodeDoubleClick(p.node)} style={{ cursor: 'pointer' }}>
            <rect x={p.x} y={p.y} width={nodeWidth} height={nodeHeight} rx={8}
              fill={ok ? 'rgba(34,197,94,0.12)' : 'rgba(248,81,73,0.1)'}
              stroke={active ? '#60a5fa' : ok ? '#22c55e' : '#f87171'}
              strokeWidth={active ? 2 : 1.2} />
            <text x={p.x + 10} y={p.y + 18} fontSize="11" fill="var(--text)" fontWeight="600">{p.node.name}</text>
            <text x={p.x + 10} y={p.y + 34} fontSize="10" fill="#94a3b8">{p.node.role}</text>
          </g>
        )
      })}
    </svg>
  )
}
