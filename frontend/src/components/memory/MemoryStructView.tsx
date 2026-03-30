export default function MemoryStructView() {
  return (
    <div style={{ padding: '1.5rem' }}>
      <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>运行时内存结构</h2>
      <div style={{
        padding: '3rem',
        textAlign: 'center',
        color: 'var(--text-muted)',
        background: 'var(--bg-secondary)',
        borderRadius: '8px',
        border: '1px solid var(--border)',
      }}>
        <p>PGPROC / PGXACT / BufferDesc 内存结构图（eBPF 采集完成后展示）</p>
      </div>
    </div>
  )
}