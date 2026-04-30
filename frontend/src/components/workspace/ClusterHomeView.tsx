import { useMemo } from 'react'
import type { CSSProperties } from 'react'
import { usePGStore } from '../../stores/pgStore'
import type { View } from '../../App'
import type { WorkspaceProject } from '../../types/workspace'
import type { ClusterNodeConfig } from '../../types/cluster'

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

export default function ClusterHomeView(props: Props) {
  const { setConfig, setConnected, setVersion } = usePGStore()
  const cluster = useMemo(
    () => props.project?.clusters.find((c) => c.id === props.selectedClusterId) ?? props.project?.clusters[0],
    [props.project, props.selectedClusterId],
  )

  const activateNode = async (node: ClusterNodeConfig, view: View) => {
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
    if (!data.success) return
    setConfig({
      host: node.host,
      port: node.port,
      user: node.user,
      password: node.password,
      database: node.database,
    })
    setConnected(true)
    setVersion(data.version || '')
    props.onNavigate(view)
  }

  return (
    <div style={{ padding: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <h2 style={{ margin: 0 }}>集群主页</h2>
        <button onClick={props.onCreateCluster} style={btn}>+ 新建集群</button>
      </div>
      {!props.project && <div style={{ color: 'var(--text-muted)' }}>请先在项目主页创建并选择项目。</div>}
      {props.project && (
        <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '0.9rem' }}>
          <div style={panel}>
            {props.project.clusters.map((c) => (
              <div key={c.id} style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '0.6rem', marginBottom: '0.5rem', background: c.id === cluster?.id ? 'var(--bg-tertiary)' : 'var(--bg)' }}>
                <div style={{ fontWeight: 700 }}>{c.name}</div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{c.replicationType} | 节点: {c.nodes.length}</div>
                <div style={{ marginTop: '0.45rem', display: 'flex', gap: '0.4rem' }}>
                  <button onClick={() => props.onSelectCluster(c.id)} style={smallBtn}>选择</button>
                  <button onClick={() => props.onRemoveCluster(c.id)} style={smallBtnDanger}>删除</button>
                </div>
              </div>
            ))}
          </div>

          <div style={panel}>
            {!cluster && <div style={{ color: 'var(--text-muted)' }}>请选择集群查看拓扑与节点。</div>}
            {cluster && (
              <>
                <h3 style={{ marginTop: 0 }}>{cluster.name} / 拓扑</h3>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.7rem' }}>
                  {cluster.nodes.map((n) => (
                    <div key={n.id} style={chip}>{n.name} ({n.role})</div>
                  ))}
                  {cluster.nodes.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>暂无节点</div>}
                </div>
                <div style={{ marginBottom: '0.6rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>节点管理</div>
                {cluster.nodes.map((n) => (
                  <div key={n.id} style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '0.55rem', marginBottom: '0.5rem', background: 'var(--bg)' }}>
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
                      <button onClick={() => activateNode(n, 'node_home')} style={smallBtn}>激活</button>
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
      )}
    </div>
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
const chip: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: '999px',
  padding: '0.25rem 0.55rem',
  fontSize: '0.78rem',
  background: 'var(--bg)',
}
const input: CSSProperties = {
  width: '100%',
  padding: '0.4rem 0.5rem',
  border: '1px solid var(--border)',
  borderRadius: '6px',
  background: 'var(--bg)',
  color: 'var(--text)',
  fontSize: '0.8rem',
}
