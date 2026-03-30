interface PipelineViewProps {
  type: 'write' | 'read' | 'transaction'
}

export default function PipelineView({ type }: PipelineViewProps) {
  const title = type === 'write' ? '数据写入 Pipeline' : type === 'read' ? '数据读取 Pipeline' : '事务执行 Pipeline'

  return (
    <div style={{ padding: '1.5rem' }}>
      <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>{title}</h2>
      <div style={{
        padding: '3rem',
        textAlign: 'center',
        color: 'var(--text-muted)',
        background: 'var(--bg-secondary)',
        borderRadius: '8px',
        border: '1px solid var(--border)',
      }}>
        <p>动态 Pipeline 可视化（eBPF 采集完成后展示）</p>
        <p style={{ fontSize: '0.75rem', marginTop: '0.5rem' }}>
          当前阶段：等待 eBPF 采集器就绪后，将实时展示执行流程
        </p>
      </div>
    </div>
  )
}