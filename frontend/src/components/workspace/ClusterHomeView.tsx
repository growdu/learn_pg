import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { usePGStore } from '../../stores/pgStore'
import type { View } from '../../App'
import type { WorkspaceProject } from '../../types/workspace'
import type { ClusterNodeConfig, ClusterNodeStatus, ClusterOverviewResponse } from '../../types/cluster'

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
}

interface OverviewState {
  loading: boolean
  error: string
  nodes: ClusterNodeStatus[]
  timestamp: number
}

export default function ClusterHomeView(props: Props) {
  const { setConfig, setConnected, setVersion } = usePGStore()
  const [overview, setOverview] = useState<OverviewState>({ loading: false, error: '', nodes: [], timestamp: 0 })
  const [selectedEdgeKey, setSelectedEdgeKey] = useState('')
  const [selectedNodeId, setSelectedNodeId] = useState('')

  const cluster = useMemo(
    () => props.project?.clusters.find((c) => c.id === props.selectedClusterId) ?? props.project?.clusters[0],
    [props.project, props.selectedClusterId],
  )

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
        if (!stop) {
          setOverview({ loading: false, error: '', nodes: data.nodes || [], timestamp: data.timestamp || Date.now() })
        }
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
    return { totalClusters, totalNodes, connectedNodes, unhealthyNodes }
  }, [props.project, overview.nodes])

  const topologyEdges = useMemo(() => {
    if (!cluster) return [] as Array<{ from: string; to: string; label: string }>
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
      const ch = fromStatus?.physical_replication?.[0]
      return {
        from: fromNode.name,
        to: toNode.name,
        mode: '物理复制',
        state: ch?.state || '-',
        sync: ch?.sync_state || '-',
        lag: ch?.lag_bytes?.toString() || '-',
      }
    }

    const sub = toStatus?.subscriptions?.[0]
    return {
      from: fromNode.name,
      to: toNode.name,
      mode: '逻辑复制',
      state: sub?.enabled ? 'enabled' : 'disabled',
      sync: sub?.worker_type || '-',
      lag: sub?.latest_end_lsn || '-',
    }
  }, [cluster, clusterStatuses, selectedEdgeKey])

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
                  <h3 style={{ marginTop: 0 }}>{cluster.name} · 拓扑</h3>
                  <div style={{ marginBottom: '0.7rem', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--bg)', padding: '0.5rem' }}>
                    <TopologyMap
                      cluster={cluster}
                      statuses={clusterStatuses}
                      edges={topologyEdges}
                      selectedEdgeKey={selectedEdgeKey}
                      selectedNodeId={selectedNodeId}
                      onEdgeClick={(key) => { setSelectedEdgeKey(key); setSelectedNodeId('') }}
                      onNodeClick={(nodeId) => { setSelectedNodeId(nodeId); setSelectedEdgeKey('') }}
                    />
                    {(selectedEdgeDetail || selectedNodeId) && (
                      <div style={{ marginTop: '0.5rem', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                        {selectedEdgeDetail && (
                          <div>
                            链路详情: {selectedEdgeDetail.from} -> {selectedEdgeDetail.to} | 模式: {selectedEdgeDetail.mode} | state: {selectedEdgeDetail.state} | sync: {selectedEdgeDetail.sync} | lag/lsn: {selectedEdgeDetail.lag}
                          </div>
                        )}
                        {selectedNodeId && <div>已选择节点，可在下方点击“激活节点”进入单节点观测。</div>}
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
                      </div>
                    ))}
                    {overview.timestamp > 0 && <div style={{ marginTop: '0.3rem', fontSize: '0.72rem', color: 'var(--text-muted)' }}>最近刷新：{new Date(overview.timestamp).toLocaleString()}</div>}
                  </div>

                  <div style={{ marginBottom: '0.6rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>节点管理</div>
                  {cluster.nodes.map((n) => (
                    <div key={n.id} data-node-id={n.id} style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '0.55rem', marginBottom: '0.5rem', background: 'var(--bg)' }}>
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
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
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
  statuses,
  edges,
  selectedEdgeKey,
  selectedNodeId,
  onEdgeClick,
  onNodeClick,
}: {
  cluster: WorkspaceProject['clusters'][number]
  statuses: ClusterNodeStatus[]
  edges: Array<{ from: string; to: string; label: string }>
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
  const gap = cluster.nodes.length <= 1 ? 0 : (width - 80 - nodeWidth) / (cluster.nodes.length - 1)

  const byId = new Map(statuses.map((s) => [s.id, s]))
  const positions = cluster.nodes.map((n, idx) => ({ id: n.id, x: 40 + idx * gap, y, node: n, status: byId.get(n.id) }))
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
            <rect x={p.x} y={p.y} width={nodeWidth} height={nodeHeight} rx={8} ry={8} fill={ok ? 'rgba(34,197,94,0.15)' : 'rgba(248,113,113,0.12)'} stroke={active ? '#60a5fa' : ok ? '#22c55e' : '#f87171'} strokeWidth={active ? 2 : 1.2} />
            <text x={p.x + 10} y={p.y + 18} fontSize="11" fill="var(--text)">{p.node.name}</text>
            <text x={p.x + 10} y={p.y + 33} fontSize="10" fill="#94a3b8">{p.node.role}</text>
          </g>
        )
      })}
    </svg>
  )
}

const panel: CSSProperties = { border: '1px solid var(--border)', borderRadius: '10px', background: 'var(--bg-secondary)', padding: '0.75rem' }
const btn: CSSProperties = { padding: '0.42rem 0.75rem', border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--bg)', color: 'var(--text)', cursor: 'pointer' }
const smallBtn: CSSProperties = { ...btn, padding: '0.25rem 0.6rem', fontSize: '0.78rem' }
const smallBtnDanger: CSSProperties = { ...smallBtn, color: 'var(--red)' }
const input: CSSProperties = { width: '100%', padding: '0.4rem 0.5rem', border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--bg)', color: 'var(--text)', fontSize: '0.8rem' }
