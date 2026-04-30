import type { WorkspaceProject } from '../../types/workspace'
import type { CSSProperties } from 'react'

interface Props {
  projects: WorkspaceProject[]
  selectedProjectId: string
  onSelectProject: (id: string) => void
  onCreateProject: () => void
  onCreateTemplateProject: (template: 'physical' | 'logical') => void
  onRemoveProject: (id: string) => void
}

export default function ProjectHomeView({
  projects,
  selectedProjectId,
  onSelectProject,
  onCreateProject,
  onCreateTemplateProject,
  onRemoveProject,
}: Props) {
  const selected = projects.find((p) => p.id === selectedProjectId) ?? projects[0]

  return (
    <div style={{ padding: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <h2 style={{ margin: 0 }}>项目主页</h2>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <button onClick={() => onCreateTemplateProject('physical')} style={smallBtn}>+ 物理复制模板</button>
          <button onClick={() => onCreateTemplateProject('logical')} style={smallBtn}>+ 逻辑复制模板</button>
          <button onClick={onCreateProject} style={btn}>+ 新建项目</button>
        </div>
      </div>
      <div style={{ color: 'var(--text-muted)', fontSize: '0.84rem', marginBottom: '0.8rem' }}>
        先创建项目，再在项目中创建集群或组件，然后继续创建节点。
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '0.9rem' }}>
        <div style={panel}>
          {projects.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>暂无项目，请先新建。</div>}
          {projects.map((p) => (
            <div key={p.id} style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '0.6rem', marginBottom: '0.5rem', background: p.id === selected?.id ? 'var(--bg-tertiary)' : 'var(--bg)' }}>
              <div style={{ fontWeight: 700 }}>{p.name}</div>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                集群: {p.clusters.length} | 组件: {p.components.length}
              </div>
              <div style={{ marginTop: '0.45rem', display: 'flex', gap: '0.4rem' }}>
                <button onClick={() => onSelectProject(p.id)} style={smallBtn}>选择</button>
                <button onClick={() => onRemoveProject(p.id)} style={smallBtnDanger}>删除</button>
              </div>
            </div>
          ))}
        </div>

        <div style={panel}>
          <h3 style={{ marginTop: 0 }}>项目拓扑</h3>
          {!selected && <div style={{ color: 'var(--text-muted)' }}>请选择项目查看拓扑。</div>}
          {selected && (
            <>
              <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>项目：{selected.name}</div>
              <div style={{ marginBottom: '0.5rem', fontSize: '0.78rem', color: 'var(--text-muted)' }}>集群</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                {selected.clusters.map((c) => (
                  <div key={c.id} style={chip}>{c.name}</div>
                ))}
                {selected.clusters.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>暂无集群</div>}
              </div>
              <div style={{ margin: '0.7rem 0', borderTop: '1px dashed var(--border)' }} />
              <div style={{ marginBottom: '0.5rem', fontSize: '0.78rem', color: 'var(--text-muted)' }}>组件</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                {selected.components.map((c) => (
                  <div key={c.id} style={chip}>{c.name}</div>
                ))}
                {selected.components.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>暂无组件</div>}
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
