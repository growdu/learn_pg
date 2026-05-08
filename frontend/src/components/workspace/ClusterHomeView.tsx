import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { usePGStore } from '../../stores/pgStore'
import type { View } from '../../App'
import type { WorkspaceProject } from '../../types/workspace'
import type { ClusterNodeConfig, ClusterNodeStatus, ClusterOverviewResponse, ReplicationChannel } from '../../types/cluster'

interface Props {
  project: WorkspaceProject | undefined
  selectedClusterId: string
  onSelectCluster: (id: string) => void
  onCreateCluster: () => void
  onRemoveCluster: (id: string) => void
  onUpdateClusterNode: (clusterId: string, nodeId: string, patch: Partial<ClusterNodeConfig>) => void
  onAddNode: (clusterId: string) => void
  onRemoveNode: (clusterId: string, nodeId: string) => void
  onNavigate: (view: View) => void
  onReloadWorkspace: () => Promise<boolean>
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
  dataDir?: string
  service?: string
  confidence?: string
}
interface ImportLogEntry {
  ts: number
  level: 'info' | 'success' | 'error'
  message: string
}

export default function ClusterHomeView(props: Props) {
  const { setConfig, setConnected, setVersion } = usePGStore()
  const [overview, setOverview] = useState<OverviewState>({ loading: false, error: '', nodes: [], timestamp: 0 })
  const [selectedEdgeKey, setSelectedEdgeKey] = useState('')
  const [selectedNodeId, setSelectedNodeId] = useState('')
  const [sourceFilter, setSourceFilter] = useState<'all' | 'provisioned' | 'discovered' | 'dsn' | 'manual'>('all')
  const [scanHost, setScanHost] = useState('127.0.0.1')
  const [scanLoading, setScanLoading] = useState(false)
  const [scanError, setScanError] = useState('')
  const [instances, setInstances] = useState<DiscoveredInstance[]>([])
  const [dsn, setDsn] = useState('')
  const [dsnLoading, setDsnLoading] = useState(false)
  const [dsnMessage, setDsnMessage] = useState('')
  const [importUser, setImportUser] = useState('postgres')
  const [importPassword, setImportPassword] = useState('')
  const [importDatabase, setImportDatabase] = useState('postgres')
  const [autoConnectAfterImport, setAutoConnectAfterImport] = useState(false)
  const [highlightNodeId, setHighlightNodeId] = useState('')
  const [lastImportedNodeId, setLastImportedNodeId] = useState('')
  const [copyMessage, setCopyMessage] = useState('')
  const [pendingAutoActivateNodeId, setPendingAutoActivateNodeId] = useState('')
  const [importLogs, setImportLogs] = useState<ImportLogEntry[]>([])

  const cluster = useMemo(
    () => props.project?.clusters.find((c) => c.id === props.selectedClusterId) ?? props.project?.clusters[0],
    [props.project, props.selectedClusterId],
  )

  const alertThresholdSec = cluster?.alertThresholdSec ?? 30
  const alertThresholdBytes = alertThresholdSec * 1024 * 1024

  const requestNodes = useMemo(() => {
    if (!props.project) return []
    return props.project.clusters.flatMap((c) =>
      c.nodes.map((n) => ({
        id: n.id,
        name: n.name,
        host: n.host,
        port: n.port,
        user: n.user,
        password: n.password,
        database: n.database,
        cluster_type: c.replicationType,
        role: n.role,
      })),
    )
  }, [props.project])

  useEffect(() => {
    let stop = false

    const loadOverview = async () => {
      if (!props.project || requestNodes.length === 0) {
        if (!stop) setOverview({ loading: false, error: '', nodes: [], timestamp: 0 })
        return
      }
      if (!stop) setOverview((prev) => ({ ...prev, loading: prev.nodes.length === 0, error: '' }))

      try {
        const res = await fetch('/api/cluster/overview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodes: requestNodes }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as ClusterOverviewResponse
        if (!data.success) throw new Error(data.error || '获取集群状态失败')
        if (!stop) setOverview({ loading: false, error: '', nodes: data.nodes || [], timestamp: data.timestamp || Date.now() })
      } catch (err) {
        if (!stop) {
          const msg = err instanceof Error ? err.message : '获取集群状态失败'
          setOverview((prev) => ({ ...prev, loading: false, error: msg }))
        }
      }
    }

    loadOverview()
    const timer = window.setInterval(loadOverview, 5000)
    return () => {
      stop = true
      window.clearInterval(timer)
    }
  }, [props.project, requestNodes])

  const activateNode = async (node: ClusterNodeConfig, view: View) => {
    const res = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: node.host, port: node.port, user: node.user, password: node.password, database: node.database }),
    })
    const data = await res.json()
    if (!data.success) return

    setConfig({ host: node.host, port: node.port, user: node.user, password: node.password, database: node.database })
    setConnected(true)
    setVersion(data.version || '')
    props.onNavigate(view)
  }

  const runHostScan = async () => {
    setScanLoading(true)
    setScanError('')
    try {
      addLog('info', `开始探测主机 ${scanHost.trim() || '-'}`)
      const res = await fetch('/api/discovery/host/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: scanHost.trim() }),
      })
      const data = (await res.json()) as { success?: boolean; error?: string; instances?: DiscoveredInstance[] }
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`)
      setInstances(data.instances ?? [])
      addLog('success', `主机探测完成，发现 ${data.instances?.length ?? 0} 个候选实例`)
    } catch (err) {
      setScanError(err instanceof Error ? err.message : '主机探测失败')
      setInstances([])
      addLog('error', `主机探测失败：${err instanceof Error ? err.message : '未知错误'}`)
    } finally {
      setScanLoading(false)
    }
  }

  const importDiscovered = async (instance: DiscoveredInstance) => {
    if (!props.project || !cluster) return
    try {
      addLog('info', `开始导入主机实例 ${instance.host}:${instance.port}`)
      const res = await fetch('/api/discovery/host/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: props.project.id,
          clusterId: cluster.id,
          instance,
          autoConnect: autoConnectAfterImport,
          user: importUser,
          password: importPassword,
          database: importDatabase,
        }),
      })
      const data = (await res.json()) as { success?: boolean; error?: string; nodeId?: string }
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`)
      await props.onReloadWorkspace()
      addLog('success', `主机实例导入成功 ${instance.host}:${instance.port}`)
      if (data.nodeId) {
        setHighlightNodeId(data.nodeId)
        setLastImportedNodeId(data.nodeId)
        if (autoConnectAfterImport) setPendingAutoActivateNodeId(data.nodeId)
      }
    } catch (err) {
      setScanError(err instanceof Error ? err.message : '导入失败')
      addLog('error', `主机实例导入失败：${err instanceof Error ? err.message : '未知错误'}`)
    }
  }

  const validateAndImportDSN = async () => {
    if (!props.project || !cluster || !dsn.trim()) return
    setDsnLoading(true)
    setDsnMessage('')
    try {
      addLog('info', '开始校验 DSN')
      const valRes = await fetch('/api/discovery/dsn/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dsn: dsn.trim() }),
      })
      const valData = (await valRes.json()) as { success?: boolean; reachable?: boolean; version?: string; error?: string }
      if (!valRes.ok || !valData.success || !valData.reachable) throw new Error(valData.error || 'DSN 校验失败')
      addLog('success', `DSN 校验通过，版本 ${valData.version || '-'}`)

      const impRes = await fetch('/api/discovery/dsn/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: props.project.id, clusterId: cluster.id, dsn: dsn.trim(), autoConnect: autoConnectAfterImport }),
      })
      const impData = (await impRes.json()) as { success?: boolean; error?: string; nodeId?: string }
      if (!impRes.ok || !impData.success) throw new Error(impData.error || 'DSN 导入失败')
      setDsnMessage(`DSN 导入成功，版本 ${valData.version || '-'}`)
      await props.onReloadWorkspace()
      addLog('success', 'DSN 导入成功')
      if (impData.nodeId) {
        setHighlightNodeId(impData.nodeId)
        setLastImportedNodeId(impData.nodeId)
        if (autoConnectAfterImport) setPendingAutoActivateNodeId(impData.nodeId)
      }
    } catch (err) {
      setDsnMessage(err instanceof Error ? err.message : 'DSN 导入失败')
      addLog('error', `DSN 导入失败：${err instanceof Error ? err.message : '未知错误'}`)
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
    return () => {
      window.clearTimeout(timer)
      window.clearTimeout(clear)
    }
  }, [highlightNodeId, props.project])

  useEffect(() => {
    if (!pendingAutoActivateNodeId || !cluster) return
    const node = cluster.nodes.find((n) => n.id === pendingAutoActivateNodeId)
    if (!node) return
    void activateNode(node, 'node_home')
    setPendingAutoActivateNodeId('')
  }, [pendingAutoActivateNodeId, cluster])

  const clusterStatuses = useMemo(() => {
    if (!cluster) return []
    const ids = new Set(cluster.nodes.map((n) => n.id))
    return overview.nodes.filter((n) => ids.has(n.id))
  }, [cluster, overview.nodes])

  const filteredClusterNodes = useMemo(() => {
    if (!cluster) return []
    if (sourceFilter === 'all') return cluster.nodes
    return cluster.nodes.filter((n) => (n.source ?? 'manual') === sourceFilter)
  }, [cluster, sourceFilter])

  const filteredClusterStatuses = useMemo(() => {
    const ids = new Set(filteredClusterNodes.map((n) => n.id))
    return clusterStatuses.filter((s) => ids.has(s.id))
  }, [filteredClusterNodes, clusterStatuses])

  const lastImportedNode = useMemo(() => {
    if (!cluster || !lastImportedNodeId) return null
    return cluster.nodes.find((n) => n.id === lastImportedNodeId) ?? null
  }, [cluster, lastImportedNodeId])

  const summary = useMemo(() => {
    const totalClusters = props.project?.clusters.length ?? 0
    const totalNodes = props.project?.clusters.reduce((acc, c) => acc + c.nodes.length, 0) ?? 0
    const connectedNodes = overview.nodes.filter((n) => n.connected).length
    const unhealthyNodes = overview.nodes.filter((n) => !n.connected).length
    return { totalClusters, totalNodes, connectedNodes, unhealthyNodes }
  }, [props.project, overview.nodes])

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
      return {
        mode: '物理复制',
        from: fromNode.name,
        to: toNode.name,
        state: ch?.state || '-',
        syncState: ch?.sync_state || '-',
        sentLSN: ch?.sent_lsn || '-',
        writeLSN: ch?.write_lsn || '-',
        flushLSN: ch?.flush_lsn || '-',
        replayLSN: ch?.replay_lsn || '-',
        writeLag: ch?.write_lag || '-',
        flushLag: ch?.flush_lag || '-',
        replayLag: ch?.replay_lag || '-',
        lagBytes,
        isAlert: lagBytes >= alertThresholdBytes,
      }
    }

    const sub = toStatus?.subscriptions?.[0]
    return {
      mode: '逻辑复制',
      from: fromNode.name,
      to: toNode.name,
      state: sub?.enabled ? 'enabled' : 'disabled',
      syncState: sub?.worker_type || '-',
      sentLSN: '-',
      writeLSN: '-',
      flushLSN: '-',
      replayLSN: sub?.latest_end_lsn || '-',
      writeLag: '-',
      flushLag: '-',
      replayLag: sub?.latest_end_time || '-',
      lagBytes: 0,
      isAlert: false,
    }
  }, [cluster, clusterStatuses, selectedEdgeKey, alertThresholdBytes])

  const copyText = async (text: string, okMsg: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopyMessage(okMsg)
    } catch {
      setCopyMessage('复制失败，请手动复制。')
    }
    window.setTimeout(() => setCopyMessage(''), 1800)
  }

  const addLog = (level: ImportLogEntry['level'], message: string) => {
    setImportLogs((prev) => [{ ts: Date.now(), level, message }, ...prev].slice(0, 20))
  }

  return (
    <div style={{ padding: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <h2 style={{ margin: 0 }}>集群主页</h2>
        <button onClick={props.onCreateCluster} style={btn}>+ 新建集群</button>
      </div>

      {!props.project && <div style={{ color: 'var(--text-muted)' }}>请先在项目主页创建并选择项目。</div>}

      {props.project && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '0.6rem', marginBottom: '0.8rem' }}>
            <SummaryCard label="集群总数" value={String(summary.totalClusters)} />
            <SummaryCard label="节点总数" value={String(summary.totalNodes)} />
            <SummaryCard label="在线节点" value={String(summary.connectedNodes)} accent="var(--green)" />
            <SummaryCard label="异常节点" value={String(summary.unhealthyNodes)} accent={summary.unhealthyNodes > 0 ? 'var(--red)' : 'var(--text)'} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '0.9rem' }}>
            <div style={panel}>
              <h3 style={{ marginTop: 0, marginBottom: '0.6rem' }}>集群列表</h3>
              {props.project.clusters.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>暂无集群，请先创建。</div>}
              {props.project.clusters.map((c) => {
                const cids = new Set(c.nodes.map((n) => n.id))
                const online = overview.nodes.filter((n) => cids.has(n.id) && n.connected).length
                return (
                  <div key={c.id} style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '0.6rem', marginBottom: '0.5rem', background: c.id === cluster?.id ? 'var(--bg-tertiary)' : 'var(--bg)' }}>
                    <div style={{ fontWeight: 700 }}>{c.name}</div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                      {c.replicationType === 'physical' ? '物理复制' : '逻辑复制'} | 节点: {c.nodes.length} | 在线: {online}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>告警阈值: {c.alertThresholdSec ?? 30}s</div>
                    <div style={{ marginTop: '0.45rem', display: 'flex', gap: '0.4rem' }}>
                      <button onClick={() => props.onSelectCluster(c.id)} style={smallBtn}>选择</button>
                      <button onClick={() => props.onRemoveCluster(c.id)} style={smallBtnDanger}>删除</button>
                    </div>
                  </div>
                )
              })}
            </div>

            <div style={panel}>
              {!cluster && <div style={{ color: 'var(--text-muted)' }}>请选择集群查看拓扑、同步状态和节点管理。</div>}
              {cluster && (
                <>
                  {lastImportedNode && (
                    <div style={{ marginBottom: '0.65rem', border: '1px solid #60a5fa', borderRadius: '8px', padding: '0.55rem', background: 'rgba(96,165,250,0.08)' }}>
                      <div style={{ fontSize: '0.8rem', fontWeight: 700, marginBottom: '0.35rem' }}>
                        新节点已导入：{lastImportedNode.name}（{lastImportedNode.host}:{lastImportedNode.port}）
                      </div>
                      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                        <button onClick={() => void activateNode(lastImportedNode, 'node_home')} style={smallBtn}>进入节点主页</button>
                        <button onClick={() => void activateNode(lastImportedNode, 'sql')} style={smallBtn}>进入 SQL 观测</button>
                        <button onClick={() => void copyText(`${lastImportedNode.host}:${lastImportedNode.port}`, '已复制主机端口')} style={smallBtn}>复制主机端口</button>
                        <button
                          onClick={() => void copyText(`postgresql://${lastImportedNode.user}:${lastImportedNode.password}@${lastImportedNode.host}:${lastImportedNode.port}/${lastImportedNode.database}`, '已复制 DSN')}
                          style={smallBtn}
                        >
                          复制 DSN
                        </button>
                        <button onClick={() => setLastImportedNodeId('')} style={smallBtnDanger}>关闭</button>
                      </div>
                      {copyMessage && <div style={{ marginTop: '0.35rem', fontSize: '0.76rem', color: 'var(--green)' }}>{copyMessage}</div>}
                    </div>
                  )}

                  <h3 style={{ marginTop: 0 }}>{cluster.name} · 拓扑</h3>
                  <div style={{ marginBottom: '0.7rem', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--bg)', padding: '0.5rem' }}>
                    <TopologyMap
                      cluster={cluster}
                      statuses={filteredClusterStatuses}
                      nodes={filteredClusterNodes}
                      edges={topologyEdges}
                      selectedEdgeKey={selectedEdgeKey}
                      selectedNodeId={selectedNodeId}
                      onEdgeClick={(key) => {
                        setSelectedEdgeKey(key)
                        setSelectedNodeId('')
                      }}
                      onNodeClick={(nodeId) => {
                        setSelectedNodeId(nodeId)
                        setSelectedEdgeKey('')
                      }}
                    />

                    {selectedEdgeDetail && (
                      <div style={{ marginTop: '0.45rem', borderTop: '1px dashed var(--border)', paddingTop: '0.45rem', fontSize: '0.78rem' }}>
                        <div style={{ fontWeight: 700 }}>
                          链路详情: {selectedEdgeDetail.from} -&gt; {selectedEdgeDetail.to}
                          <span style={{ marginLeft: '0.5rem', color: selectedEdgeDetail.isAlert ? 'var(--red)' : 'var(--green)' }}>
                            {selectedEdgeDetail.isAlert ? '告警' : '正常'}
                          </span>
                        </div>
                        <div style={{ color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                          模式: {selectedEdgeDetail.mode} | state: {selectedEdgeDetail.state} | sync: {selectedEdgeDetail.syncState}
                        </div>
                        <div style={{ color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                          sent/write/flush/replay: {selectedEdgeDetail.sentLSN} / {selectedEdgeDetail.writeLSN} / {selectedEdgeDetail.flushLSN} / {selectedEdgeDetail.replayLSN}
                        </div>
                        <div style={{ color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                          writeLag/flushLag/replayLag: {selectedEdgeDetail.writeLag} / {selectedEdgeDetail.flushLag} / {selectedEdgeDetail.replayLag}
                        </div>
                        <div style={{ color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                          lag_bytes: {selectedEdgeDetail.lagBytes}（阈值: {alertThresholdBytes}）
                        </div>
                      </div>
                    )}
                  </div>

                  <div style={{ marginBottom: '0.55rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>同步状态看板</div>
                  <div style={{ marginBottom: '0.9rem' }}>
                    {overview.loading && <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>正在加载集群状态...</div>}
                    {!overview.loading && overview.error && <div style={{ color: 'var(--red)', fontSize: '0.82rem' }}>状态获取失败：{overview.error}</div>}
                    {!overview.loading && !overview.error && clusterStatuses.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>当前集群暂无状态数据。</div>}
                    {!overview.loading && !overview.error && clusterStatuses.map((n) => (
                      <div key={n.id} style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '0.55rem', marginBottom: '0.45rem', background: 'var(--bg)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div style={{ fontWeight: 700, fontSize: '0.84rem' }}>{n.name}</div>
                          <span style={{ fontSize: '0.75rem', color: n.connected ? 'var(--green)' : 'var(--red)' }}>{n.connected ? '在线' : '离线'}</span>
                        </div>
                        <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                          角色: {n.role} | in_recovery: {String(n.in_recovery)} | 版本: {n.version || '-'}
                        </div>
                        <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                          current_lsn: {n.current_lsn || '-'} | replay_lsn: {n.replay_lsn || '-'}
                        </div>
                      </div>
                    ))}
                    {overview.timestamp > 0 && <div style={{ marginTop: '0.3rem', fontSize: '0.72rem', color: 'var(--text-muted)' }}>最近刷新：{new Date(overview.timestamp).toLocaleString()}</div>}
                  </div>

                  <div style={{ marginBottom: '0.6rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>节点管理</div>
                  <div style={{ marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>来源筛选</span>
                    <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value as typeof sourceFilter)} style={input}>
                      <option value="all">全部</option>
                      <option value="provisioned">自动拉起</option>
                      <option value="discovered">主机探测</option>
                      <option value="dsn">DSN 导入</option>
                      <option value="manual">手动配置</option>
                    </select>
                  </div>
                  {filteredClusterNodes.map((n) => (
                    <div
                      key={n.id}
                      data-node-id={n.id}
                      style={{
                        border: highlightNodeId === n.id ? '1px solid #60a5fa' : '1px solid var(--border)',
                        boxShadow: highlightNodeId === n.id ? '0 0 0 2px rgba(96,165,250,0.25)' : 'none',
                        borderRadius: '8px',
                        padding: '0.55rem',
                        marginBottom: '0.5rem',
                        background: 'var(--bg)',
                      }}
                    >
                      <div style={{ marginBottom: '0.35rem' }}>
                        <span style={sourceBadge(n.source)}>{sourceLabel(n.source)}</span>
                      </div>
                      <input value={n.name} onChange={(e) => props.onUpdateClusterNode(cluster.id, n.id, { name: e.target.value })} style={input} placeholder="节点名称" />
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: '0.4rem', marginTop: '0.4rem' }}>
                        <input value={n.host} onChange={(e) => props.onUpdateClusterNode(cluster.id, n.id, { host: e.target.value })} style={input} placeholder="主机" />
                        <input type="number" value={n.port} onChange={(e) => props.onUpdateClusterNode(cluster.id, n.id, { port: Number(e.target.value) })} style={input} />
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem', marginTop: '0.4rem' }}>
                        <input value={n.user} onChange={(e) => props.onUpdateClusterNode(cluster.id, n.id, { user: e.target.value })} style={input} placeholder="用户" />
                        <input type="password" value={n.password} onChange={(e) => props.onUpdateClusterNode(cluster.id, n.id, { password: e.target.value })} style={input} placeholder="密码" />
                      </div>
                      <input value={n.database} onChange={(e) => props.onUpdateClusterNode(cluster.id, n.id, { database: e.target.value })} style={{ ...input, marginTop: '0.4rem' }} placeholder="数据库" />
                      <input value={n.role} onChange={(e) => props.onUpdateClusterNode(cluster.id, n.id, { role: e.target.value })} style={{ ...input, marginTop: '0.4rem' }} placeholder="角色（primary/standby/publisher/subscriber）" />
                      <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem' }}>
                        <button onClick={() => activateNode(n, 'node_home')} style={smallBtn}>激活节点</button>
                        <button onClick={() => activateNode(n, 'sql')} style={smallBtn}>观测 SQL</button>
                        <button onClick={() => props.onRemoveNode(cluster.id, n.id)} style={smallBtnDanger}>移除节点</button>
                      </div>
                    </div>
                  ))}
                  <button onClick={() => props.onAddNode(cluster.id)} style={btn}>+ 添加节点</button>
                  <div style={{ marginTop: '0.9rem', paddingTop: '0.75rem', borderTop: '1px dashed var(--border)' }}>
                    <div style={{ marginBottom: '0.45rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>主机探测导入</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.45rem', marginBottom: '0.45rem' }}>
                      <input value={importUser} onChange={(e) => setImportUser(e.target.value)} style={input} placeholder="用户名" />
                      <input type="password" value={importPassword} onChange={(e) => setImportPassword(e.target.value)} style={input} placeholder="密码" />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '0.45rem', marginBottom: '0.45rem' }}>
                      <input value={importDatabase} onChange={(e) => setImportDatabase(e.target.value)} style={input} placeholder="数据库名" />
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                        <input type="checkbox" checked={autoConnectAfterImport} onChange={(e) => setAutoConnectAfterImport(e.target.checked)} />
                        自动连接
                      </label>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '0.45rem' }}>
                      <input value={scanHost} onChange={(e) => setScanHost(e.target.value)} style={input} placeholder="主机 IP，例如 192.168.3.99" />
                      <button onClick={runHostScan} style={smallBtn}>{scanLoading ? '探测中...' : '探测'}</button>
                    </div>
                    {scanError && <div style={{ marginTop: '0.35rem', fontSize: '0.76rem', color: 'var(--red)' }}>{scanError}</div>}
                    {instances.map((ins, idx) => (
                      <div key={`${ins.host}:${ins.port}-${idx}`} style={{ marginTop: '0.4rem', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.45rem', background: 'var(--bg)' }}>
                        <div style={{ fontSize: '0.78rem' }}>{ins.host}:{ins.port} | {ins.service || 'postgresql'} | 置信度: {ins.confidence || '-'}</div>
                        <button onClick={() => importDiscovered(ins)} style={{ ...smallBtn, marginTop: '0.35rem' }}>导入到当前集群</button>
                      </div>
                    ))}
                  </div>

                  <div style={{ marginTop: '0.9rem', paddingTop: '0.75rem', borderTop: '1px dashed var(--border)' }}>
                    <div style={{ marginBottom: '0.45rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>DSN 导入</div>
                    <input value={dsn} onChange={(e) => setDsn(e.target.value)} style={input} placeholder="postgresql://user:pass@host:5432/dbname" />
                    <div style={{ marginTop: '0.4rem' }}>
                      <button onClick={validateAndImportDSN} style={smallBtn}>{dsnLoading ? '处理中...' : '校验并导入'}</button>
                    </div>
                    {dsnMessage && <div style={{ marginTop: '0.35rem', fontSize: '0.76rem', color: dsnMessage.includes('成功') ? 'var(--green)' : 'var(--red)' }}>{dsnMessage}</div>}
                  </div>

                  <div style={{ marginTop: '0.9rem', paddingTop: '0.75rem', borderTop: '1px dashed var(--border)' }}>
                    <div style={{ marginBottom: '0.45rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>导入操作日志</span>
                      <button onClick={() => setImportLogs([])} style={smallBtn}>清空</button>
                    </div>
                    {importLogs.length === 0 && <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>暂无日志</div>}
                    {importLogs.map((x) => (
                      <div key={`${x.ts}-${x.message}`} style={{ fontSize: '0.75rem', color: x.level === 'error' ? 'var(--red)' : x.level === 'success' ? 'var(--green)' : 'var(--text-muted)', marginBottom: '0.25rem' }}>
                        [{new Date(x.ts).toLocaleTimeString()}] {x.message}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function pickChannel(channels: ReplicationChannel[] | undefined, nodeName: string): ReplicationChannel | undefined {
  if (!channels || channels.length === 0) return undefined
  const key = nodeName.toLowerCase()
  return channels.find((c) => c.name.toLowerCase().includes(key)) ?? channels[0]
}

function SummaryCard({ label, value, accent = 'var(--text)' }: { label: string; value: string; accent?: string }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: '10px', background: 'var(--bg-secondary)', padding: '0.6rem 0.75rem' }}>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ marginTop: '0.1rem', fontSize: '1.05rem', fontWeight: 700, color: accent }}>{value}</div>
    </div>
  )
}

function TopologyMap({
  cluster,
  nodes,
  statuses,
  edges,
  selectedEdgeKey,
  selectedNodeId,
  onEdgeClick,
  onNodeClick,
}: {
  cluster: WorkspaceProject['clusters'][number]
  nodes: WorkspaceProject['clusters'][number]['nodes']
  statuses: ClusterNodeStatus[]
  edges: EdgeInfo[]
  selectedEdgeKey: string
  selectedNodeId: string
  onEdgeClick: (key: string) => void
  onNodeClick: (nodeId: string) => void
}) {
  const width = 760
  const height = 210
  const y = 105
  const nodeWidth = 120
  const nodeHeight = 44
  const gap = nodes.length <= 1 ? 0 : (width - 80 - nodeWidth) / (nodes.length - 1)

  const byId = new Map(statuses.map((s) => [s.id, s]))
  const positions = nodes.map((n, idx) => ({ id: n.id, x: 40 + idx * gap, y, node: n, status: byId.get(n.id) }))
  const posMap = new Map(positions.map((p) => [p.id, p]))

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="210" role="img" aria-label="复制拓扑图">
      <defs>
        <marker id="arrow" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L10,4 L0,8 z" fill="#94a3b8" />
        </marker>
      </defs>
      {edges.map((e) => {
        const from = posMap.get(e.from)
        const to = posMap.get(e.to)
        if (!from || !to) return null
        const key = `${e.from}->${e.to}`
        const active = key === selectedEdgeKey
        const x1 = from.x + nodeWidth
        const y1 = from.y + nodeHeight / 2
        const x2 = to.x
        const y2 = to.y + nodeHeight / 2
        const mx = (x1 + x2) / 2
        return (
          <g key={key} onClick={() => onEdgeClick(key)} style={{ cursor: 'pointer' }}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={active ? '#60a5fa' : '#94a3b8'} strokeWidth={active ? 2 : 1.4} markerEnd="url(#arrow)" />
            <text x={mx} y={y1 - 8} textAnchor="middle" fontSize="10" fill="#94a3b8">{e.label}</text>
          </g>
        )
      })}
      {positions.map((p) => {
        const ok = p.status?.connected ?? false
        const active = selectedNodeId === p.id
        return (
          <g key={p.id} onClick={() => onNodeClick(p.id)} style={{ cursor: 'pointer' }}>
            <rect
              x={p.x}
              y={p.y}
              width={nodeWidth}
              height={nodeHeight}
              rx={8}
              ry={8}
              fill={ok ? 'rgba(34,197,94,0.15)' : 'rgba(248,113,113,0.12)'}
              stroke={active ? '#60a5fa' : ok ? '#22c55e' : '#f87171'}
              strokeWidth={active ? 2 : 1.2}
            />
            <text x={p.x + 10} y={p.y + 18} fontSize="11" fill="var(--text)">{p.node.name}</text>
            <text x={p.x + 10} y={p.y + 33} fontSize="10" fill="#94a3b8">{p.node.role} · {sourceLabel(p.node.source)}</text>
          </g>
        )
      })}
    </svg>
  )
}

const panel: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: '10px',
  background: 'var(--bg-secondary)',
  padding: '0.75rem',
}
const btn: CSSProperties = {
  padding: '0.42rem 0.75rem',
  border: '1px solid var(--border)',
  borderRadius: '6px',
  background: 'var(--bg)',
  color: 'var(--text)',
  cursor: 'pointer',
}
const smallBtn: CSSProperties = { ...btn, padding: '0.25rem 0.6rem', fontSize: '0.78rem' }
const smallBtnDanger: CSSProperties = { ...smallBtn, color: 'var(--red)' }
const input: CSSProperties = {
  width: '100%',
  padding: '0.4rem 0.5rem',
  border: '1px solid var(--border)',
  borderRadius: '6px',
  background: 'var(--bg)',
  color: 'var(--text)',
  fontSize: '0.8rem',
}

function sourceLabel(source?: string): string {
  if (source === 'provisioned') return '自动拉起'
  if (source === 'discovered') return '主机探测'
  if (source === 'dsn') return 'DSN 导入'
  return '手动配置'
}

function sourceBadge(source?: string): CSSProperties {
  const color = source === 'provisioned'
    ? '#22c55e'
    : source === 'discovered'
      ? '#3b82f6'
      : source === 'dsn'
        ? '#f59e0b'
        : '#94a3b8'
  return {
    display: 'inline-block',
    padding: '0.1rem 0.45rem',
    borderRadius: '999px',
    fontSize: '0.72rem',
    border: `1px solid ${color}`,
    color,
    background: 'transparent',
  }
}
