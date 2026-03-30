export default function BufferHeatmapView() {
  return (
    <div style={{ padding: '1.5rem' }}>
      <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>Buffer Pool 热图</h2>
      <div style={{
        padding: '3rem',
        textAlign: 'center',
        color: 'var(--text-muted)',
        background: 'var(--bg-secondary)',
        borderRadius: '8px',
        border: '1px solid var(--border)',
      }}>
        <p>Buffer Pool 热图（eBPF 采集完成后展示）</p>
      </div>
    </div>
  )
}