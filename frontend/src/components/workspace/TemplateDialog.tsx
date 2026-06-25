import { useState, type CSSProperties } from 'react'
import { ALL_TEMPLATES, type ReplicationTemplate, type TemplateParams } from '../../types/template'

export type TemplateCreateMode = 'preview' | 'create'

interface Props {
  onConfirm: (templateId: ReplicationTemplate, name: string, params: TemplateParams, mode: TemplateCreateMode) => void
  onCancel: () => void
}

const PREVIEW_STYLE: CSSProperties = {
  fontFamily: 'ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, monospace',
  fontSize: '0.72rem',
  lineHeight: 1.45,
  color: 'var(--text-muted)',
  whiteSpace: 'pre' as const,
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: '6px',
  padding: '0.6rem 0.8rem',
  userSelect: 'none' as const,
}

export default function TemplateDialog({ onConfirm, onCancel }: Props) {
  const [selected, setSelected] = useState<ReplicationTemplate>('physical')
  const [name, setName] = useState(() => {
    const t = ALL_TEMPLATES.find((x) => x.id === 'physical')!
    return `我的${t.name.replace('模板', '项目')}`
  })
  const [params, setParams] = useState<TemplateParams>(() => ALL_TEMPLATES.find((x) => x.id === 'physical')!.defaultParams)
  const [mode, setMode] = useState<TemplateCreateMode>('create')

  const template = ALL_TEMPLATES.find((x) => x.id === selected)!

  const handleSelect = (id: ReplicationTemplate) => {
    setSelected(id)
    const t = ALL_TEMPLATES.find((x) => x.id === id)!
    setParams(t.defaultParams)
    setName(`我的${t.name.replace('模板', '项目')}`)
  }

  return (
    <div style={overlay} onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div style={dialog}>
        <div style={header}>
          <h3 style={{ margin: 0 }}>创建集群项目</h3>
          <button onClick={onCancel} style={closeBtn}>×</button>
        </div>

        <div style={body}>
          <div style={{ display: 'flex', gap: '0.7rem', marginBottom: '1rem' }}>
            {ALL_TEMPLATES.map((t) => (
              <div
                key={t.id}
                onClick={() => handleSelect(t.id)}
                style={{
                  ...templateCard,
                  borderColor: selected === t.id ? 'var(--accent)' : 'var(--border)',
                  background: selected === t.id ? 'var(--bg-tertiary)' : 'var(--bg)',
                }}
              >
                <div style={{ fontWeight: 700, fontSize: '0.88rem' }}>{t.name}</div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                  {t.id === 'single' ? '单节点快速观测' : t.id === 'physical' ? '一主多从流复制' : '发布订阅逻辑复制'}
                </div>
                {selected === t.id && <div style={selectedBadge}>已选择</div>}
              </div>
            ))}
          </div>

          <div style={{ marginBottom: '0.9rem' }}>
            <div style={label}>说明</div>
            <div style={{ fontSize: '0.82rem', color: 'var(--text)' }}>{template.description}</div>
          </div>

          <div style={{ marginBottom: '0.9rem' }}>
            <div style={label}>拓扑预览</div>
            <div style={PREVIEW_STYLE}>{template.preview}</div>
          </div>

          <div style={{ marginBottom: '0.9rem' }}>
            <div style={label}>项目名称</div>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} style={input} placeholder="输入项目名称" />
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <div style={label}>参数配置</div>

            <div style={{ marginBottom: '0.5rem' }}>
              <div style={rangeTitle}><span>节点数量</span><span style={{ fontWeight: 700 }}>{params.nodeCount}</span></div>
              <input
                type="range"
                min={selected === 'single' ? 1 : 2}
                max={8}
                value={params.nodeCount}
                onChange={(e) => setParams((p) => ({ ...p, nodeCount: Number(e.target.value) }))}
                style={range}
              />
              <div style={rangeHint}><span>{selected === 'single' ? 1 : 2}</span><span>8</span></div>
            </div>

            <div style={{ marginBottom: '0.5rem' }}>
              <div style={rangeTitle}><span>复制延迟告警阈值</span><span style={{ fontWeight: 700 }}>{params.alertThresholdSec}s</span></div>
              <input
                type="range"
                min={5}
                max={300}
                step={5}
                value={params.alertThresholdSec}
                onChange={(e) => setParams((p) => ({ ...p, alertThresholdSec: Number(e.target.value) }))}
                style={range}
              />
              <div style={rangeHint}><span>5s</span><span>300s</span></div>
            </div>

            <div style={{ marginTop: '0.6rem' }}>
              <div style={label}>自动创建组件</div>
              <label style={checkRow}><input type="checkbox" checked={params.createCollector} onChange={(e) => setParams((p) => ({ ...p, createCollector: e.target.checked }))} /><span>采集组件（collector）</span></label>
              <label style={checkRow}><input type="checkbox" checked={params.createAnalyzer} onChange={(e) => setParams((p) => ({ ...p, createAnalyzer: e.target.checked }))} /><span>分析组件（analyzer）</span></label>
              <label style={checkRow}><input type="checkbox" checked={params.createStorage} onChange={(e) => setParams((p) => ({ ...p, createStorage: e.target.checked }))} /><span>存储组件（storage）</span></label>
            </div>

            <div style={{ marginTop: '0.6rem' }}>
              <div style={label}>组件命名规则</div>
              <input type="text" value={params.componentNamePattern} onChange={(e) => setParams((p) => ({ ...p, componentNamePattern: e.target.value }))} style={input} placeholder="{project}-{type}" />
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>可用变量：{'{project}'}、{'{type}'}，例如：{'{project}'}-{'{type}'}</div>
            </div>
          </div>

          <div style={{ marginBottom: '1rem', padding: '0.8rem', background: 'var(--bg-tertiary)', borderRadius: '8px', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: '0.82rem', fontWeight: 600, marginBottom: '0.6rem' }}>创建方式</div>
            <label style={{ ...checkRow, marginBottom: '0.4rem' }}>
              <input
                type="radio"
                name="createMode"
                value="create"
                checked={mode === 'create'}
                onChange={() => setMode('create')}
              />
              <div>
                <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>真实创建集群</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>调用后端 provision，拉起真实 PostgreSQL 容器</div>
              </div>
            </label>
            <label style={checkRow}>
              <input
                type="radio"
                name="createMode"
                value="preview"
                checked={mode === 'preview'}
                onChange={() => setMode('preview')}
              />
              <div>
                <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>仅预览模板</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>查看集群拓扑结构，不调用后端，不写入 workspace</div>
              </div>
            </label>
          </div>
        </div>

        <div style={footer}>
          <button onClick={onCancel} style={cancelBtn}>取消</button>
          <button onClick={() => onConfirm(selected, name.trim() || template.name, params, mode)} style={confirmBtn}>
            {mode === 'preview' ? '预览' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}

const label: CSSProperties = { fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '0.35rem', fontWeight: 600 }
const rangeTitle: CSSProperties = { display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '0.2rem' }
const rangeHint: CSSProperties = { display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--text-muted)' }
const overlay: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }
const dialog: CSSProperties = { background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '12px', width: '580px', maxWidth: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }
const header: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem 1.2rem', borderBottom: '1px solid var(--border)' }
const closeBtn: CSSProperties = { background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: 'var(--text-muted)', padding: '0 0.3rem' }
const body: CSSProperties = { padding: '1rem 1.2rem', overflowY: 'auto', flex: 1 }
const templateCard: CSSProperties = { flex: 1, border: '2px solid var(--border)', borderRadius: '8px', padding: '0.65rem 0.8rem', cursor: 'pointer', position: 'relative', transition: 'border-color 0.15s' }
const selectedBadge: CSSProperties = { position: 'absolute', top: '-1px', right: '-1px', background: 'var(--accent)', color: '#fff', fontSize: '0.68rem', fontWeight: 700, padding: '0.1rem 0.4rem', borderRadius: '0 6px 0 6px' }
const input: CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '0.4rem 0.6rem', border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--bg)', color: 'var(--text)', fontSize: '0.85rem' }
const range: CSSProperties = { width: '100%', accentColor: 'var(--accent)', cursor: 'pointer' }
const checkRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.82rem', marginBottom: '0.3rem' }
const footer: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: '0.6rem', padding: '0.8rem 1.2rem', borderTop: '1px solid var(--border)' }
const cancelBtn: CSSProperties = { padding: '0.4rem 1rem', border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--bg)', color: 'var(--text)', cursor: 'pointer', fontSize: '0.85rem' }
const confirmBtn: CSSProperties = { padding: '0.4rem 1rem', border: 'none', borderRadius: '6px', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600 }
