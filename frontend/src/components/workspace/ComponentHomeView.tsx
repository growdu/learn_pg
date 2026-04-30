import type { WorkspaceProject } from '../../types/workspace'
import type { CSSProperties } from 'react'

interface Props {
  project: WorkspaceProject | undefined
  onCreateComponent: () => void
  onRemoveComponent: (id: string) => void
  onToggleLink: (componentId: string, clusterId: string) => void
}

export default function ComponentHomeView({
  project,
  onCreateComponent,
  onRemoveComponent,
  onToggleLink,
}: Props) {
  return (
    <div style={{ padding: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <h2 style={{ margin: 0 }}>组件主页</h2>
        <button onClick={onCreateComponent} style={btn}>+ 新建组件</button>
      </div>
      {!project && <div style={{ color: 'var(--text-muted)' }}>请先在项目主页创建并选择项目。</div>}
      {project && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0.8rem' }}>
          <div style={panel}>
            <h3 style={{ marginTop: 0 }}>组件 → 集群 → 节点 拓扑</h3>
            {project.components.length === 0 && <div style={{ color: 'var(--text-muted)' }}>暂无组件，请先创建。</div>}
            {project.components.map((comp) => (
              <div key={comp.id} style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '0.65rem', marginBottom: '0.55rem', background: 'var(--bg)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{comp.name}</div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{comp.componentType}</div>
                  </div>
                  <button onClick={() => onRemoveComponent(comp.id)} style={smallBtnDanger}>删除</button>
                </div>

                <div style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>关联集群</div>
                <div style={{ marginTop: '0.3rem', display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                  {project.clusters.map((c) => {
                    const active = comp.linkedClusterIds.includes(c.id)
                    return (
                      <button
                        key={c.id}
                        onClick={() => onToggleLink(comp.id, c.id)}
                        style={{
                          ...smallBtn,
                          background: active ? 'var(--bg-tertiary)' : 'var(--bg)',
                          borderColor: active ? 'var(--accent)' : 'var(--border)',
                          color: active ? 'var(--accent)' : 'var(--text)',
                        }}
                      >
                        {active ? '已关联' : '关联'} {c.name}
                      </button>
                    )
                  })}
                  {project.clusters.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>暂无集群可关联</div>}
                </div>

                <div style={{ marginTop: '0.6rem', border: '1px dashed var(--border)', borderRadius: '8px', padding: '0.5rem' }}>
                  <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginBottom: '0.35rem' }}>拓扑视图</div>
                  {comp.linkedClusterIds.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>尚未关联任何集群</div>}
                  {comp.linkedClusterIds.map((cid) => {
                    const cluster = project.clusters.find((c) => c.id === cid)
                    if (!cluster) return null
                    return (
                      <div key={cid} style={{ marginBottom: '0.45rem', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.45rem' }}>
                        <div style={{ fontSize: '0.8rem', fontWeight: 600 }}>{comp.name} → {cluster.name}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                          节点：{cluster.nodes.map((n) => n.name).join('、') || '暂无节点'}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
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
