import type { CSSProperties } from 'react'
import type { WorkspaceProject } from '../../types/workspace'

interface Props {
  projects: WorkspaceProject[]
  selectedProjectId: string
  onSelectProject: (id: string) => void
  onCreateProject: () => void
  onOpenTemplateDialog: () => void
  onRemoveProject: (id: string) => void
}

export default function ProjectHomeView({
  projects,
  selectedProjectId,
  onSelectProject,
  onCreateProject,
  onOpenTemplateDialog,
  onRemoveProject,
}: Props) {
  const selected = projects.find((p) => p.id === selectedProjectId) ?? projects[0]

  return (
    <div style={{ padding: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <h2 style={{ margin: 0 }}>项目主页</h2>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <button onClick={onOpenTemplateDialog} style={btn}>+ 从模板创建</button>
          <button onClick={onCreateProject} style={btn}>+ 新建空白项目</button>
        </div>
      </div>

      <div style={{ color: 'var(--text-muted)', fontSize: '0.84rem', marginBottom: '0.8rem' }}>
        先创建项目，再创建集群和组件，最后进入节点观测。这里展示项目级拓扑总览。
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '0.9rem' }}>
        <div style={panel}>
          <h3 style={{ marginTop: 0, marginBottom: '0.6rem' }}>项目列表</h3>
          {projects.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>暂无项目，请先新建。</div>}
          {projects.map((p) => (
            <div
              key={p.id}
              style={{
                border: '1px solid var(--border)',
                borderRadius: '8px',
                padding: '0.6rem',
                marginBottom: '0.5rem',
                background: p.id === selected?.id ? 'var(--bg-tertiary)' : 'var(--bg)',
              }}
            >
              <div style={{ fontWeight: 700 }}>{p.name}</div>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                集群: {p.clusters.length} | 组件: {p.components.length} | 节点: {p.clusters.reduce((acc, c) => acc + c.nodes.length, 0)}
              </div>
              <div style={{ marginTop: '0.45rem', display: 'flex', gap: '0.4rem' }}>
                <button onClick={() => onSelectProject(p.id)} style={smallBtn}>选择</button>
                <button onClick={() => onRemoveProject(p.id)} style={smallBtnDanger}>删除</button>
              </div>
            </div>
          ))}
        </div>

        <div style={panel}>
          <h3 style={{ marginTop: 0 }}>项目拓扑总览</h3>
          {!selected && <div style={{ color: 'var(--text-muted)' }}>请选择项目查看拓扑。</div>}
          {selected && (
            <>
              <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: '0.6rem' }}>项目：{selected.name}</div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div style={subPanel}>
                  <div style={subTitle}>集群与节点</div>
                  {selected.clusters.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>暂无集群</div>}
                  {selected.clusters.map((c) => (
                    <div key={c.id} style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '0.45rem', marginBottom: '0.4rem', background: 'var(--bg)' }}>
                      <div style={{ fontWeight: 700, fontSize: '0.84rem' }}>{c.name}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>
                        类型: {c.replicationType === 'physical' ? '物理复制' : '逻辑复制'} | 节点: {c.nodes.length}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginTop: '0.3rem' }}>
                        {c.nodes.map((n) => (
                          <span key={n.id} style={chip}>{n.name}({n.role})</span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                <div style={subPanel}>
                  <div style={subTitle}>组件与关联关系</div>
                  {selected.components.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>暂无组件</div>}
                  {selected.components.map((comp) => {
                    const linked = selected.clusters.filter((c) => comp.linkedClusterIds.includes(c.id))
                    return (
                      <div key={comp.id} style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '0.45rem', marginBottom: '0.4rem', background: 'var(--bg)' }}>
                        <div style={{ fontWeight: 700, fontSize: '0.84rem' }}>{comp.name}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>类型: {comp.componentType}</div>
                        <div style={{ marginTop: '0.25rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          关联集群: {linked.length > 0 ? linked.map((c) => c.name).join('，') : '未关联'}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const panel: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: '10px',
  background: 'var(--bg-secondary)',
  padding: '0.75rem',
}
const subPanel: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: '8px',
  background: 'var(--bg-secondary)',
  padding: '0.6rem',
}
const subTitle: CSSProperties = {
  fontSize: '0.8rem',
  color: 'var(--text-muted)',
  marginBottom: '0.45rem',
  fontWeight: 700,
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
  padding: '0.2rem 0.5rem',
  fontSize: '0.74rem',
  background: 'var(--bg)',
}
