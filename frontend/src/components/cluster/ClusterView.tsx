import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { usePGStore } from '../../stores/pgStore'
import type { ClusterNodeConfig, ClusterNodeStatus, ClusterOverviewResponse, ClusterType } from '../../types/cluster'

const genId = () => crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)

const STORAGE_KEY = 'pgv_cluster_nodes'

const ROLE_OPTIONS_BY_TYPE: Record<ClusterType, { label: string; value: string }[]> = {
  physical: [
    { label: '物理主节点 (Primary)', value: 'primary' },
    { label: '物理从节点 (Standby)', value: 'standby' },
  ],
  logical: [
    { label: '逻辑发布端 (Publisher)', value: 'publisher' },
    { label: '逻辑订阅端 (Subscriber)', value: 'subscriber' },
  ],
}

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
      const custom = evt as CustomEvent<{ node?: ClusterNodeConfig; view?: 'node_home' | 'sql' | 'wal' | 'clog' | 'memory' }>
      if (custom.detail?.node) {
        void activateNode(custom.detail.node, custom.detail.view || 'node_home')
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

  const updateNodeType = (id: string, clusterType: ClusterType) => {
    const next = nodes.map((node) => {
      if (node.id !== id) return node
      const validRoles = ROLE_OPTIONS_BY_TYPE[clusterType].map((r) => r.value)
      const role = validRoles.includes(node.role) ? node.role : validRoles[0]
      return { ...node, cluster_type: clusterType, role }
    })
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

  const activateNode = async (node: ClusterNodeConfig, targetView: 'node_home' | 'sql' | 'wal' | 'clog' | 'memory' = 'node_home') => {
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
          <h2 style={{ margin: 0, fontSize: '1rem' }}>闆嗙兢鑺傜偣绠＄悊</h2>
          <button onClick={addNode} style={btnSecondary}>+ 娣诲姞鑺傜偣</button>
        </div>
        <div style={{ marginBottom: '0.75rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          鏀寔娣诲姞鍜岀Щ闄よ妭鐐广€傝嚦灏戜繚鐣?1 涓妭鐐癸紱鍙湪姣忎釜鑺傜偣鎵ц婵€娲讳笌瑙傛祴銆?        </div>
        {nodes.map((node) => (
          <div key={node.id} style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '0.75rem', marginBottom: '0.75rem' }}>
            <input value={node.name} onChange={(e) => updateNode(node.id, { name: e.target.value })} style={inputStyle} placeholder="鑺傜偣鍚嶇О" />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 88px', gap: '0.5rem', marginTop: '0.5rem' }}>
              <input value={node.host} onChange={(e) => updateNode(node.id, { host: e.target.value })} style={inputStyle} placeholder="涓绘満" />
              <input type="number" value={node.port} onChange={(e) => updateNode(node.id, { port: Number(e.target.value) })} style={inputStyle} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginTop: '0.5rem' }}>
              <input value={node.user} onChange={(e) => updateNode(node.id, { user: e.target.value })} style={inputStyle} placeholder="鐢ㄦ埛" />
              <input type="password" value={node.password} onChange={(e) => updateNode(node.id, { password: e.target.value })} style={inputStyle} placeholder="瀵嗙爜" />
            </div>
            <input value={node.database} onChange={(e) => updateNode(node.id, { database: e.target.value })} style={{ ...inputStyle, marginTop: '0.5rem' }} placeholder="鏁版嵁搴? />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginTop: '0.5rem' }}>
              <select value={node.cluster_type} onChange={(e) => updateNodeType(node.id, e.target.value as ClusterType)} style={inputStyle}>
                <option value="physical">物理复制 (physical)</option>
                <option value="logical">逻辑复制 (logical)</option>
              </select>
              <select
                value={ROLE_OPTIONS_BY_TYPE[node.cluster_type].some((r) => r.value === node.role) ? node.role : '__custom__'}
                onChange={(e) => {
                  const v = e.target.value
                  if (v !== '__custom__') updateNode(node.id, { role: v })
                }}
                style={inputStyle}
              >
                {ROLE_OPTIONS_BY_TYPE[node.cluster_type].map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
                <option value="__custom__">自定义角色</option>
              </select>
            </div>
            <input
              value={node.role}
              onChange={(e) => updateNode(node.id, { role: e.target.value })}
              style={{ ...inputStyle, marginTop: '0.5rem' }}
              placeholder="角色英文值（例如 primary / standby / publisher / subscriber）"
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.5rem' }}>
              <button onClick={() => setSelectedNodeId(node.id)} style={btnSecondary}>鏌ョ湅</button>
              <button onClick={() => activateNode(node, 'node_home')} disabled={activating} style={{ ...btnSecondary, borderColor: 'var(--accent)', color: 'var(--accent)' }}>
                {activating ? '婵€娲讳腑...' : '婵€娲?}
              </button>
              <button onClick={() => removeNode(node.id)} disabled={nodes.length <= 1} style={btnDanger}>绉婚櫎</button>
            </div>
          </div>
        ))}
        <button onClick={refreshCluster} disabled={loading} style={{ ...btnPrimary, width: '100%' }}>
          {loading ? '鍒锋柊涓?..' : '鍒锋柊闆嗙兢鐘舵€?}
        </button>
        {error && <div style={{ color: 'var(--red)', marginTop: '0.75rem', fontSize: '0.85rem' }}>{error}</div>}
      </div>

      <div style={{ flex: 1, padding: '1rem', overflowY: 'auto' }}>
        {!snapshot && <div style={{ color: 'var(--text-muted)' }}>璇风偣鍑烩€滃埛鏂伴泦缇ょ姸鎬佲€濆姞杞芥嫇鎵戜笌鍚屾鐘舵€併€?/div>}
        {snapshot && (
          <>
            <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem' }}>
              <SummaryCard label="鑺傜偣鏁? value={String(snapshot.summary.total_nodes)} />
              <SummaryCard label="鍦ㄧ嚎鑺傜偣" value={String(snapshot.summary.connected_nodes)} />
              <SummaryCard label="鐗╃悊澶嶅埗鑺傜偣" value={String(snapshot.summary.physical_nodes)} />
              <SummaryCard label="閫昏緫澶嶅埗鑺傜偣" value={String(snapshot.summary.logical_nodes)} />
            </div>

            <h3 style={{ marginBottom: '0.5rem' }}>闆嗙兢鎷撴墤</h3>
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
      {lane('鐗╃悊澶嶅埗涓昏妭鐐?(Primary)', physicalPrimary)}
      <TopologyArrows fromCount={physicalPrimary.length} toCount={physicalStandby.length} label="鐗╃悊娴佸鍒? color="#0ea5e9" />
      {lane('鐗╃悊澶嶅埗浠庤妭鐐?(Standby)', physicalStandby)}
      {lane('閫昏緫澶嶅埗鍙戝竷绔?(Publisher)', logicalPublisher)}
      <TopologyArrows fromCount={logicalPublisher.length} toCount={logicalSubscriber.length} label="閫昏緫澶嶅埗" color="#22c55e" />
      {lane('閫昏緫澶嶅埗璁㈤槄绔?(Subscriber)', logicalSubscriber)}
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
    '閰嶇疆鑷冲皯 1 涓妭鐐瑰苟鎴愬姛 Refresh锛坈onnected >= 1锛?,
    '鐗╃悊澶嶅埗锛歅rimary 涓?Standby 鍚屾椂鍦ㄧ嚎锛屾鏌?lag_bytes 涓?sync_state',
    '閫昏緫澶嶅埗锛歅ublisher/Subscriber 鍦ㄧ嚎锛屾鏌?subscription latest_end_lsn',
    '浠庤妭鐐硅鎯呯偣鍑?Observe SQL/WAL/CLOG/Snapshot锛岀‘璁よ兘璺宠浆骞跺彲璇绘暟鎹?,
    '鍒囨崲涓嶅悓鑺傜偣閲嶅楠岃瘉锛岀‘璁や笂涓嬫枃杩炴帴鍒囨崲姝ｇ‘',
  ]
  return (
    <div style={{ marginTop: '0.9rem', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--bg)', padding: '0.75rem' }}>
      <h4 style={{ margin: 0, marginBottom: '0.5rem' }}>鑱斿悎璋冭瘯娓呭崟</h4>
      {steps.map((step, idx) => (
        <div key={step} style={{ fontSize: '0.83rem', marginBottom: '0.25rem', color: 'var(--text-muted)' }}>
          {idx + 1}. {step}
        </div>
      ))}
      <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.4rem' }}>
        <button onClick={onExport} style={btnSecondary} disabled={logs.length === 0}>瀵煎嚭鏃ュ織</button>
        <button onClick={onClear} style={btnSecondary} disabled={logs.length === 0}>娓呯┖鏃ュ織</button>
      </div>
      <div style={{ marginTop: '0.5rem', maxHeight: '180px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.45rem', background: 'var(--bg-secondary)' }}>
        {logs.length === 0 && <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>鏆傛棤鏃ュ織銆?/div>}
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
  const activateAndGo = async (view: 'node_home' | 'sql' | 'wal' | 'clog' | 'memory') => {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const nodes = JSON.parse(raw) as ClusterNodeConfig[]
    const cfg = nodes.find((n) => n.id === node.id)
    if (!cfg) return
    window.dispatchEvent(new CustomEvent('pgv-activate-request', { detail: { node: cfg, view } }))
  }

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--bg-secondary)', padding: '1rem' }}>
      <h3 style={{ marginTop: 0, marginBottom: '0.5rem' }}>鑺傜偣璇︽儏锛歿node.name}</h3>
      <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
        {node.host}:{node.port}/{node.database} | {node.cluster_type} / {node.role}
      </div>
      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        <button onClick={() => activateAndGo('node_home')} style={btnSecondary}>鑺傜偣涓婚〉</button>
        <button onClick={() => activateAndGo('sql')} style={btnSecondary}>瑙傛祴 SQL</button>
        <button onClick={() => activateAndGo('wal')} style={btnSecondary}>瑙傛祴 WAL</button>
        <button onClick={() => activateAndGo('clog')} style={btnSecondary}>瑙傛祴 CLOG</button>
        <button onClick={() => activateAndGo('memory')} style={btnSecondary}>瑙傛祴蹇収</button>
      </div>
      {!node.connected && <div style={{ color: 'var(--red)' }}>{node.error || '杩炴帴澶辫触'}</div>}
      {node.connected && (
        <>
          <div style={{ fontSize: '0.85rem', marginBottom: '0.25rem' }}>鐗堟湰锛歿node.version || '-'}</div>
          <div style={{ fontSize: '0.85rem', marginBottom: '0.25rem' }}>鎭㈠妯″紡锛歿String(node.in_recovery)}</div>
          <div style={{ fontSize: '0.85rem', marginBottom: '0.25rem' }}>褰撳墠 LSN锛歿node.current_lsn || '-'}</div>
          <div style={{ fontSize: '0.85rem', marginBottom: '0.25rem' }}>鍥炴斁 LSN锛歿node.replay_lsn || '-'}</div>
          <div style={{ fontSize: '0.85rem', marginBottom: '0.75rem' }}>WAL 鎺ユ敹鍣細{node.wal_receiver_status || '-'}</div>

          <h4 style={{ margin: '0.25rem 0' }}>鐗╃悊鍚屾閫氶亾</h4>
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
            <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>鏈彂鐜扮墿鐞嗗鍒堕€氶亾銆?/div>
          )}

          <h4 style={{ margin: '0.25rem 0' }}>閫昏緫澶嶅埗</h4>
          <div style={{ fontSize: '0.82rem', marginBottom: '0.35rem' }}>閫昏緫妲斤細{node.logical_slots} | 鍙戝竷鏁伴噺锛歿node.publications}</div>
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
            <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>鏈彂鐜拌闃呫€?/div>
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
  if (state === 'streaming' && sync === 'sync' && lag <= 1024*1024) return '鍋ュ悍'
  if (state === 'streaming' && lag <= 16*1024*1024) return '棰勮'
  return '涓ラ噸'
}

function healthColor(ch: { state?: string; sync_state?: string; lag_bytes?: number }): string {
  const label = healthLabel(ch)
  if (label === '鍋ュ悍') return 'var(--green)'
  if (label === '棰勮') return '#d97706'
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




