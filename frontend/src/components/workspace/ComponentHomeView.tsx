import { useEffect, useState, type CSSProperties } from 'react'
import type { WorkspaceProject } from '../../types/workspace'

interface Props {
  project: WorkspaceProject | undefined
  onCreateComponent: () => void
  onRemoveComponent: (id: string) => void
  onToggleLink: (componentId: string, clusterId: string) => void
  onActivateNode: (clusterId: string, nodeId: string) => void
  highlightedComponentIds?: string[]
}

type TreeState = Record<string, boolean>

export default function ComponentHomeView({
  project,
  onCreateComponent,
  onRemoveComponent,
  onToggleLink,
  onActivateNode,
  highlightedComponentIds = [],
}: Props) {
  const [expanded, setExpanded] = useState<TreeState>({})

  useEffect(() => {
    if (!project) return
    const next: TreeState = {}
    for (const c of project.components) next[c.id] = true
    for (const cl of project.clusters) next[cl.id] = true
    setExpanded(next)
  }, [project?.id])

  const isHighlighted = (id: string) => highlightedComponentIds.includes(id)
  const toggle = (id: string) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }))

  return (
    <div style={{ padding: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <h2 style={{ margin: 0 }}>组件主页</h2>
        <button onClick={onCreateComponent} style={btn}>+ 新建组件</button>
      </div>
      {!project && <div style={{ color: 'var(--text-muted)' }}>请先在项目主页创建并选择项目。</div>}
      {project && (
        <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: '0.9rem' }}>
          <div style={panel}>
            <h3 style={{ marginTop: 0, marginBottom: '0.6rem' }}>组件 → 集群 → 节点</h3>
            {project.components.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>暂无组件，请先创建。</div>}
            {project.components.map((comp) => {
              const isOpen = expanded[comp.id] !== false
              const linkedClusters = project.clusters.filter((c) => comp.linkedClusterIds.includes(c.id))
              return (
                <div key={comp.id} style={{ marginBottom: '0.5rem' }}>
                  <div
                    style={{ ...treeRow, background: isHighlighted(comp.id) ? 'rgba(59,130,246,0.12)' : 'transparent', border: isHighlighted(comp.id) ? '1px solid var(--accent)' : '1px solid transparent' }}
                    onClick={() => toggle(comp.id)}
                    title="点击展开/收起"
                  >
                    <span style={{ color: 'var(--accent)', fontSize: '0.7rem', width: '1rem' }}>{isOpen ? '▼' : '▶'}</span>
                    <span style={icon}>●</span>
                    <span style={{ fontWeight: 700, fontSize: '0.85rem' }}>{comp.name}</span>
                    <span style={badge}>{comp.componentType}</span>
                  </div>

                  {isOpen && linkedClusters.map((cluster) => {
                    const cOpen = expanded[cluster.id] !== false
                    return (
                      <div key={cluster.id} style={{ marginLeft: '1.4rem' }}>
                        <div style={treeRow} onClick={() => toggle(cluster.id)} title="点击展开/收起">
                          <span style={{ color: 'var(--text-muted)', fontSize: '0.65rem', width: '1rem' }}>{cOpen ? '▼' : '▶'}</span>
                          <span style={icon}>◉</span>
                          <span style={{ fontWeight: 600, fontSize: '0.82rem' }}>{cluster.name}</span>
                          <span style={badge}>{cluster.replicationType === 'physical' ? '物理' : '逻辑'}</span>
                          <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--text-muted)' }}>{cluster.nodes.length} 节点</span>
                        </div>

                        {cOpen && cluster.nodes.map((node) => (
                          <div key={node.id} style={{ ...treeRow, marginLeft: '1.4rem', cursor: 'pointer' }} onClick={() => onActivateNode(cluster.id, node.id)} title={`进入节点 ${node.name}`}>
                            <span style={{ width: '1rem' }} />
                            <span style={nodeDot(node.role)} />
                            <span style={{ fontSize: '0.8rem' }}>{node.name}</span>
                            <span style={badge}>{roleLabel(node.role)}</span>
                          </div>
                        ))}
                        {cOpen && cluster.nodes.length === 0 && <div style={{ marginLeft: '2.8rem', fontSize: '0.78rem', color: 'var(--text-muted)', padding: '0.2rem 0' }}>暂无节点</div>}
                      </div>
                    )
                  })}

                  {isOpen && linkedClusters.length === 0 && <div style={{ marginLeft: '2.2rem', fontSize: '0.78rem', color: 'var(--text-muted)', padding: '0.2rem 0' }}>未关联任何集群</div>}
                </div>
              )
            })}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
            <div style={panel}>
              <h3 style={{ marginTop: 0, marginBottom: '0.6rem' }}>组件 → 集群 关联矩阵</h3>
              {project.clusters.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>暂无集群。</div>}
              {project.clusters.length > 0 && (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.8rem' }}>
                    <thead>
                      <tr>
                        <th style={th}>组件</th>
                        {project.clusters.map((c) => <th key={c.id} style={th}>{c.name}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {project.components.map((comp) => (
                        <tr key={comp.id} style={isHighlighted(comp.id) ? { background: 'rgba(59,130,246,0.08)' } : undefined}>
                          <td style={td}><span style={{ fontWeight: 600 }}>{comp.name}</span></td>
                          {project.clusters.map((cluster) => {
                            const linked = comp.linkedClusterIds.includes(cluster.id)
                            return (
                              <td key={cluster.id} style={{ ...td, textAlign: 'center' }}>
                                <button
                                  onClick={() => onToggleLink(comp.id, cluster.id)}
                                  style={{ ...matrixBtn, background: linked ? 'var(--accent)' : 'var(--bg)', color: linked ? '#fff' : 'var(--text-muted)', borderColor: linked ? 'var(--accent)' : 'var(--border)' }}
                                  title={linked ? '取消关联' : '关联'}
                                >
                                  {linked ? '●' : '○'}
                                </button>
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div style={panel}>
              <h3 style={{ marginTop: 0, marginBottom: '0.6rem' }}>组件详情</h3>
              {project.components.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>暂无组件。</div>}
              {project.components.map((comp) => {
                const linkedClusters = project.clusters.filter((c) => comp.linkedClusterIds.includes(c.id))
                return (
                  <div key={comp.id} style={{ ...card, borderColor: isHighlighted(comp.id) ? 'var(--accent)' : 'var(--border)', boxShadow: isHighlighted(comp.id) ? '0 0 0 1px rgba(59,130,246,0.2)' : 'none' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: '0.88rem' }}>{comp.name}</div>
                        <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>类型：{comp.componentType} | 关联集群：{linkedClusters.length} 个</div>
                      </div>
                      <button onClick={() => onRemoveComponent(comp.id)} style={smallBtnDanger}>删除</button>
                    </div>
                    {linkedClusters.length > 0 && (
                      <div style={{ marginTop: '0.5rem' }}>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>关联集群</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                          {linkedClusters.map((c) => (
                            <span key={c.id} style={clusterChip}>
                              {c.name}
                              <span onClick={() => onToggleLink(comp.id, c.id)} style={{ cursor: 'pointer', marginLeft: '0.3rem', color: 'var(--red)' }} title="取消关联">×</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function roleLabel(role: string): string {
  const map: Record<string, string> = {
    primary: '主节点',
    standby: '从节点',
    publisher: '发布者',
    subscriber: '订阅者',
  }
  return map[role] ?? role
}

function nodeDot(role: string): CSSProperties {
  const colorMap: Record<string, string> = {
    primary: '#4ade80',
    publisher: '#60a5fa',
    standby: '#94a3b8',
    subscriber: '#c4b5fd',
  }
  return {
    display: 'inline-block',
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: colorMap[role] ?? '#94a3b8',
    flexShrink: 0,
  }
}

const panel: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: '10px',
  background: 'var(--bg-secondary)',
  padding: '0.75rem',
}
const treeRow: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.3rem 0.4rem', borderRadius: '6px', cursor: 'default', userSelect: 'none', fontSize: '0.85rem',
}
const icon: CSSProperties = { fontSize: '0.75rem', color: 'var(--text-muted)' }
const badge: CSSProperties = { fontSize: '0.7rem', padding: '0.1rem 0.4rem', borderRadius: '999px', background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text-muted)', marginLeft: '0.2rem' }
const th: CSSProperties = { textAlign: 'left', padding: '0.35rem 0.5rem', fontSize: '0.78rem', fontWeight: 600, borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }
const td: CSSProperties = { padding: '0.35rem 0.5rem', borderBottom: '1px solid var(--border)', verticalAlign: 'middle' }
const matrixBtn: CSSProperties = { border: '1px solid var(--border)', borderRadius: '4px', padding: '0.15rem 0.4rem', cursor: 'pointer', fontSize: '0.85rem', lineHeight: 1, transition: 'all 0.15s' }
const btn: CSSProperties = { padding: '0.42rem 0.75rem', border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--bg)', color: 'var(--text)', cursor: 'pointer' }
const smallBtnDanger: CSSProperties = { ...btn, padding: '0.25rem 0.6rem', fontSize: '0.78rem', color: 'var(--red)' }
const card: CSSProperties = { border: '1px solid var(--border)', borderRadius: '8px', padding: '0.65rem 0.8rem', marginBottom: '0.5rem', background: 'var(--bg)' }
const clusterChip: CSSProperties = { display: 'inline-flex', alignItems: 'center', border: '1px solid var(--border)', borderRadius: '999px', padding: '0.15rem 0.5rem', fontSize: '0.75rem', background: 'var(--bg)', color: 'var(--text)' }
