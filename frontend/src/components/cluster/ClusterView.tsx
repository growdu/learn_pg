import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { usePGStore } from '../../stores/pgStore'
import type { ClusterNodeConfig, ClusterNodeStatus, ClusterOverviewResponse, ClusterType } from '../../types/cluster'

const genId = () => crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)

const STORAGE_KEY = 'pgv_cluster_nodes'

function loadNodes(defaultNode: ClusterNodeConfig): ClusterNodeConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as ClusterNodeConfig[]
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
    }
  } catch {
    // ignore
  }
  return [defaultNode]
}

function saveNodes(nodes: ClusterNodeConfig[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(nodes))
}

function makeDefaultNode(): ClusterNodeConfig {
  const cfg = usePGStore.getState().config
  return {
    id: genId(),
    name: 'Node 1',
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    cluster_type: 'physical',
    role: 'primary',
  }
}

export default function ClusterView() {
  const { setConfig, setConnected, setVersion } = usePGStore()
  const [nodes, setNodes] = useState<ClusterNodeConfig[]>(() => loadNodes(makeDefaultNode()))
  const [selectedNodeId, setSelectedNodeId] = useState<string>(nodes[0]?.id ?? '')
  const [loading, setLoading] = useState(false)
  const [activating, setActivating] = useState(false)
  const [error, setError] = useState('')
  const [snapshot, setSnapshot] = useState<ClusterOverviewResponse | null>(null)
  const [logs, setLogs] = useState<string[]>([])

  const selectedNode = useMemo(
    () => snapshot?.nodes.find((n) => n.id === selectedNodeId) ?? snapshot?.nodes[0],
    [snapshot, selectedNodeId],
  )

  useEffect(() => {
    const onActivateRequest = (evt: Event) => {
      const custom = evt as CustomEvent<{ node?: ClusterNodeConfig; view?: 'home' | 'wal' | 'clog' | 'memory' }>
      if (custom.detail?.node) {
        void activateNode(custom.detail.node, custom.detail.view || 'home')
      }
    }
    window.addEventListener('pgv-activate-request', onActivateRequest)
    return () => window.removeEventListener('pgv-activate-request', onActivateRequest)
  }, [nodes])

  const updateNode = (id: string, patch: Partial<ClusterNodeConfig>) => {
    const next = nodes.map((node) => (node.id === id ? { ...node, ...patch } : node))
    setNodes(next)
    saveNodes(next)
  }

  const addNode = () => {
    const idx = nodes.length + 1
    const cfg = usePGStore.getState().config
    const node: ClusterNodeConfig = {
      id: genId(),
      name: `Node ${idx}`,
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      cluster_type: 'physical',
      role: idx === 1 ? 'primary' : 'standby',
    }
    const next = [...nodes, node]
    setNodes(next)
    saveNodes(next)
  }

  const removeNode = (id: string) => {
    if (nodes.length <= 1) return
    const next = nodes.filter((node) => node.id !== id)
    setNodes(next)
    saveNodes(next)
    if (selectedNodeId === id) setSelectedNodeId(next[0].id)
  }

  const refreshCluster = async () => {
    if (nodes.length === 0) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/cluster/overview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodes }),
      })
      const data: ClusterOverviewResponse = await res.json()
      if (!data.success) {
        setError(data.error || 'failed to fetch cluster overview')
        appendLog(`REFRESH_FAIL error=${data.error || 'unknown'}`)
      } else {
        setSnapshot(data)
        appendLog(`REFRESH_OK total=${data.summary.total_nodes} connected=${data.summary.connected_nodes} physical=${data.summary.physical_nodes} logical=${data.summary.logical_nodes}`)
        if (!selectedNodeId && data.nodes.length > 0) setSelectedNodeId(data.nodes[0].id)
      }
    } catch (e) {
      setError(`request failed: ${e}`)
      appendLog(`REFRESH_FAIL request=${String(e)}`)
    } finally {
      setLoading(false)
    }
  }

  const activateNode = async (node: ClusterNodeConfig, targetView: 'home' | 'wal' | 'clog' | 'memory' = 'home') => {
    setActivating(true)
    setError('')
    try {
      const res = await fetch('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: node.host,
          port: node.port,
          user: node.user,
          password: node.password,
          database: node.database,
        }),
      })
      const data = await res.json()
      if (!data.success) {
        setError(data.error || 'failed to activate node')
        appendLog(`ACTIVATE_FAIL node=${node.name}@${node.host}:${node.port} error=${data.error || 'unknown'}`)
        return
      }

      setConfig({
        host: node.host,
        port: node.port,
        user: node.user,
        password: node.password,
        database: node.database,
      })
      setConnected(true)
      setVersion(data.version || '')
      appendLog(`ACTIVATE_OK node=${node.name}@${node.host}:${node.port} view=${targetView} version=${data.version || '-'}`)
      window.dispatchEvent(new CustomEvent('pgv-node-activated', { detail: { view: targetView } }))
    } catch (e) {
      setError(`activate failed: ${e}`)
      appendLog(`ACTIVATE_FAIL node=${node.name}@${node.host}:${node.port} error=${String(e)}`)
    } finally {
      setActivating(false)
    }
  }

  const appendLog = (line: string) => {
    const ts = new Date().toISOString()
    setLogs((prev) => [`${ts} ${line}`, ...prev].slice(0, 200))
  }

  const exportLogs = () => {
    const body = logs.join('\n')
    const blob = new Blob([body], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `cluster-debug-${Date.now()}.log`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <div style={{ width: '420px', borderRight: '1px solid var(--border)', padding: '1rem', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <h2 style={{ margin: 0, fontSize: '1rem' }}>Cluster Nodes</h2>
          <button onClick={addNode} style={btnSecondary}>+ Node</button>
        </div>
        {nodes.map((node) => (
          <div key={node.id} style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '0.75rem', marginBottom: '0.75rem' }}>
            <input value={node.name} onChange={(e) => updateNode(node.id, { name: e.target.value })} style={inputStyle} placeholder="Node Name" />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 88px', gap: '0.5rem', marginTop: '0.5rem' }}>
              <input value={node.host} onChange={(e) => updateNode(node.id, { host: e.target.value })} style={inputStyle} placeholder="Host" />
              <input type="number" value={node.port} onChange={(e) => updateNode(node.id, { port: Number(e.target.value) })} style={inputStyle} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginTop: '0.5rem' }}>
              <input value={node.user} onChange={(e) => updateNode(node.id, { user: e.target.value })} style={inputStyle} placeholder="User" />
              <input type="password" value={node.password} onChange={(e) => updateNode(node.id, { password: e.target.value })} style={inputStyle} placeholder="Password" />
            </div>
            <input value={node.database} onChange={(e) => updateNode(node.id, { database: e.target.value })} style={{ ...inputStyle, marginTop: '0.5rem' }} placeholder="Database" />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginTop: '0.5rem' }}>
              <select value={node.cluster_type} onChange={(e) => updateNode(node.id, { cluster_type: e.target.value as ClusterType })} style={inputStyle}>
                <option value="physical">physical</option>
                <option value="logical">logical</option>
              </select>
              <input value={node.role} onChange={(e) => updateNode(node.id, { role: e.target.value })} style={inputStyle} placeholder="Role" />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.5rem' }}>
              <button onClick={() => setSelectedNodeId(node.id)} style={btnSecondary}>View</button>
              <button onClick={() => activateNode(node, 'home')} disabled={activating} style={{ ...btnSecondary, borderColor: 'var(--accent)', color: 'var(--accent)' }}>
                {activating ? 'Activating...' : 'Activate'}
              </button>
              <button onClick={() => removeNode(node.id)} disabled={nodes.length <= 1} style={btnDanger}>Remove</button>
            </div>
          </div>
        ))}
        <button onClick={refreshCluster} disabled={loading} style={{ ...btnPrimary, width: '100%' }}>
          {loading ? 'Refreshing...' : 'Refresh Cluster Status'}
        </button>
        {error && <div style={{ color: 'var(--red)', marginTop: '0.75rem', fontSize: '0.85rem' }}>{error}</div>}
      </div>

      <div style={{ flex: 1, padding: '1rem', overflowY: 'auto' }}>
        {!snapshot && <div style={{ color: 'var(--text-muted)' }}>Run "Refresh Cluster Status" to load topology and sync state.</div>}
        {snapshot && (
          <>
            <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem' }}>
              <SummaryCard label="Nodes" value={String(snapshot.summary.total_nodes)} />
              <SummaryCard label="Connected" value={String(snapshot.summary.connected_nodes)} />
              <SummaryCard label="Physical" value={String(snapshot.summary.physical_nodes)} />
              <SummaryCard label="Logical" value={String(snapshot.summary.logical_nodes)} />
            </div>

            <h3 style={{ marginBottom: '0.5rem' }}>Topology</h3>
            <TopologyView nodes={snapshot.nodes} selectedNodeId={selectedNode?.id} onSelect={setSelectedNodeId} />

            {selectedNode && <NodeDetail node={selectedNode} />}
            <JointDebugChecklist logs={logs} onExport={exportLogs} onClear={() => setLogs([])} />
          </>
        )}
      </div>
    </div>
  )
}

function TopologyView({
  nodes,
  selectedNodeId,
  onSelect,
}: {
  nodes: ClusterNodeStatus[]
  selectedNodeId?: string
  onSelect: (id: string) => void
}) {
  const physicalPrimary = nodes.filter((n) => n.cluster_type === 'physical' && n.role.toLowerCase().includes('primary'))
  const physicalStandby = nodes.filter((n) => n.cluster_type === 'physical' && !n.role.toLowerCase().includes('primary'))
  const logicalPublisher = nodes.filter((n) => n.cluster_type === 'logical' && n.role.toLowerCase().includes('publisher'))
  const logicalSubscriber = nodes.filter((n) => n.cluster_type === 'logical' && !n.role.toLowerCase().includes('publisher'))

  const lane = (title: string, laneNodes: ClusterNodeStatus[]) => (
    <div style={{ marginBottom: '0.6rem' }}>
      <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginBottom: '0.35rem' }}>{title}</div>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        {laneNodes.map((node) => (
          <button
            key={node.id}
            onClick={() => onSelect(node.id)}
            style={{
              textAlign: 'left',
              border: selectedNodeId === node.id ? '1px solid var(--accent)' : '1px solid var(--border)',
              background: 'var(--bg-secondary)',
              padding: '0.5rem 0.65rem',
              borderRadius: '8px',
              cursor: 'pointer',
              color: 'var(--text)',
              minWidth: '190px',
            }}
          >
            <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{node.name}</div>
            <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>{node.host}:{node.port}</div>
            <div style={{ fontSize: '0.76rem', marginTop: '0.2rem' }}>{node.cluster_type}/{node.role}</div>
            <div style={{ marginTop: '0.2rem', fontSize: '0.76rem', color: node.connected ? 'var(--green)' : 'var(--red)' }}>
              {node.connected ? 'connected' : 'disconnected'}
            </div>
          </button>
        ))}
        {laneNodes.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>No nodes</div>}
      </div>
    </div>
  )

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '0.8rem', background: 'var(--bg)' }}>
      {lane('Physical Primary', physicalPrimary)}
      <TopologyArrows fromCount={physicalPrimary.length} toCount={physicalStandby.length} label="streaming replication" color="#0ea5e9" />
      {lane('Physical Standby', physicalStandby)}
      {lane('Logical Publisher', logicalPublisher)}
      <TopologyArrows fromCount={logicalPublisher.length} toCount={logicalSubscriber.length} label="logical replication" color="#22c55e" />
      {lane('Logical Subscriber', logicalSubscriber)}
    </div>
  )
}

function TopologyArrows({ fromCount, toCount, label, color }: { fromCount: number; toCount: number; label: string; color: string }) {
  if (fromCount === 0 || toCount === 0) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', margin: '0.15rem 0 0.6rem 0' }}>
      <div style={{ flex: 1, height: '2px', background: color }} />
      <div style={{ fontSize: '0.74rem', color }}>{label}</div>
      <div style={{ width: 0, height: 0, borderTop: '5px solid transparent', borderBottom: '5px solid transparent', borderLeft: `8px solid ${color}` }} />
    </div>
  )
}

function JointDebugChecklist({
  logs,
  onExport,
  onClear,
}: {
  logs: string[]
  onExport: () => void
  onClear: () => void
}) {
  const steps = [
    '配置至少 1 个节点并成功 Refresh（connected >= 1）',
    '物理复制：Primary 与 Standby 同时在线，检查 lag_bytes 与 sync_state',
    '逻辑复制：Publisher/Subscriber 在线，检查 subscription latest_end_lsn',
    '从节点详情点击 Observe SQL/WAL/CLOG/Snapshot，确认能跳转并可读数据',
    '切换不同节点重复验证，确认上下文连接切换正确',
  ]
  return (
    <div style={{ marginTop: '0.9rem', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--bg)', padding: '0.75rem' }}>
      <h4 style={{ margin: 0, marginBottom: '0.5rem' }}>Joint Debug Checklist</h4>
      {steps.map((step, idx) => (
        <div key={step} style={{ fontSize: '0.83rem', marginBottom: '0.25rem', color: 'var(--text-muted)' }}>
          {idx + 1}. {step}
        </div>
      ))}
      <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.4rem' }}>
        <button onClick={onExport} style={btnSecondary} disabled={logs.length === 0}>Export Logs</button>
        <button onClick={onClear} style={btnSecondary} disabled={logs.length === 0}>Clear Logs</button>
      </div>
      <div style={{ marginTop: '0.5rem', maxHeight: '180px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.45rem', background: 'var(--bg-secondary)' }}>
        {logs.length === 0 && <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>No logs yet.</div>}
        {logs.map((log) => (
          <div key={log} style={{ fontSize: '0.75rem', fontFamily: 'Consolas, monospace', color: 'var(--text-muted)', marginBottom: '0.2rem' }}>
            {log}
          </div>
        ))}
      </div>
    </div>
  )
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '0.75rem 1rem', background: 'var(--bg-secondary)' }}>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>{value}</div>
    </div>
  )
}

function NodeDetail({ node }: { node: ClusterNodeStatus }) {
  const activateAndGo = async (view: 'home' | 'wal' | 'clog' | 'memory') => {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const nodes = JSON.parse(raw) as ClusterNodeConfig[]
    const cfg = nodes.find((n) => n.id === node.id)
    if (!cfg) return
    window.dispatchEvent(new CustomEvent('pgv-activate-request', { detail: { node: cfg, view } }))
  }

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--bg-secondary)', padding: '1rem' }}>
      <h3 style={{ marginTop: 0, marginBottom: '0.5rem' }}>Node Detail: {node.name}</h3>
      <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
        {node.host}:{node.port}/{node.database} | {node.cluster_type} / {node.role}
      </div>
      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        <button onClick={() => activateAndGo('home')} style={btnSecondary}>Observe SQL</button>
        <button onClick={() => activateAndGo('wal')} style={btnSecondary}>Observe WAL</button>
        <button onClick={() => activateAndGo('clog')} style={btnSecondary}>Observe CLOG</button>
        <button onClick={() => activateAndGo('memory')} style={btnSecondary}>Observe Snapshot</button>
      </div>
      {!node.connected && <div style={{ color: 'var(--red)' }}>{node.error || 'connection failed'}</div>}
      {node.connected && (
        <>
          <div style={{ fontSize: '0.85rem', marginBottom: '0.25rem' }}>Version: {node.version || '-'}</div>
          <div style={{ fontSize: '0.85rem', marginBottom: '0.25rem' }}>Recovery: {String(node.in_recovery)}</div>
          <div style={{ fontSize: '0.85rem', marginBottom: '0.25rem' }}>Current LSN: {node.current_lsn || '-'}</div>
          <div style={{ fontSize: '0.85rem', marginBottom: '0.25rem' }}>Replay LSN: {node.replay_lsn || '-'}</div>
          <div style={{ fontSize: '0.85rem', marginBottom: '0.75rem' }}>WAL Receiver: {node.wal_receiver_status || '-'}</div>

          <h4 style={{ margin: '0.25rem 0' }}>Physical Sync Channels</h4>
          {node.physical_replication && node.physical_replication.length > 0 ? (
            node.physical_replication.map((ch) => (
              <div key={`${node.id}-${ch.name}`} style={{ fontSize: '0.82rem', padding: '0.4rem', border: '1px solid var(--border)', borderRadius: '6px', marginBottom: '0.4rem' }}>
                {ch.name || '(unnamed)'} | state={ch.state || '-'} | sync={ch.sync_state || '-'}
                <span style={{ marginLeft: '0.5rem', color: healthColor(ch), fontWeight: 600 }}>
                  [{healthLabel(ch)}]
                </span>
                <div style={{ color: 'var(--text-muted)' }}>
                  sent={ch.sent_lsn || '-'} write={ch.write_lsn || '-'} flush={ch.flush_lsn || '-'} replay={ch.replay_lsn || '-'}
                </div>
                <div style={{ color: 'var(--text-muted)' }}>lag={formatBytes(ch.lag_bytes ?? 0)}</div>
              </div>
            ))
          ) : (
            <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>No physical replication channel found.</div>
          )}

          <h4 style={{ margin: '0.25rem 0' }}>Logical Replication</h4>
          <div style={{ fontSize: '0.82rem', marginBottom: '0.35rem' }}>Logical Slots: {node.logical_slots} | Publications: {node.publications}</div>
          {node.subscriptions && node.subscriptions.length > 0 ? (
            node.subscriptions.map((sub) => (
              <div key={`${node.id}-${sub.name}`} style={{ fontSize: '0.82rem', padding: '0.4rem', border: '1px solid var(--border)', borderRadius: '6px', marginBottom: '0.4rem' }}>
                {sub.name} | enabled={String(sub.enabled)} | worker={sub.worker_type || '-'}
                <div style={{ color: 'var(--text-muted)' }}>
                  recv={sub.received_lsn || '-'} latest={sub.latest_end_lsn || '-'} time={sub.latest_end_time || '-'}
                </div>
              </div>
            ))
          ) : (
            <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>No subscription found.</div>
          )}
        </>
      )}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`
}

function healthLabel(ch: { state?: string; sync_state?: string; lag_bytes?: number }): string {
  const state = (ch.state || '').toLowerCase()
  const sync = (ch.sync_state || '').toLowerCase()
  const lag = ch.lag_bytes || 0
  if (state === 'streaming' && sync === 'sync' && lag <= 1024*1024) return 'healthy'
  if (state === 'streaming' && lag <= 16*1024*1024) return 'warning'
  return 'critical'
}

function healthColor(ch: { state?: string; sync_state?: string; lag_bytes?: number }): string {
  const label = healthLabel(ch)
  if (label === 'healthy') return 'var(--green)'
  if (label === 'warning') return '#d97706'
  return 'var(--red)'
}

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '0.45rem 0.55rem',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: '6px',
  color: 'var(--text)',
  fontSize: '0.82rem',
}

const btnPrimary: CSSProperties = {
  padding: '0.5rem 0.8rem',
  border: 'none',
  borderRadius: '6px',
  background: 'var(--accent)',
  color: 'white',
  cursor: 'pointer',
}

const btnSecondary: CSSProperties = {
  padding: '0.3rem 0.6rem',
  border: '1px solid var(--border)',
  borderRadius: '6px',
  background: 'var(--bg)',
  color: 'var(--text)',
  cursor: 'pointer',
  fontSize: '0.8rem',
}

const btnDanger: CSSProperties = {
  ...btnSecondary,
  color: 'var(--red)',
}
