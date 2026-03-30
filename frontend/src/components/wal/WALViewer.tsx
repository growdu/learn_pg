import { useState, useEffect } from 'react'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000'

export default function WALViewer() {
  const [records, setRecords] = useState<Record<string, unknown>[]>([])
  const [loading, setLoading] = useState(false)
  const [lsn, setLsn] = useState('')

  useEffect(() => {
    fetchWALRecords()
  }, [])

  const fetchWALRecords = async () => {
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/wal?lsn=${lsn}`)
      const data = await res.json()
      setRecords(Array.isArray(data.records) ? data.records : [])
    } catch {
      setRecords([])
    }
    setLoading(false)
  }

  return (
    <div style={{ padding: '1.5rem' }}>
      <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>WAL 记录查看器</h2>

      <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem', alignItems: 'center' }}>
        <input
          type="text"
          placeholder="起始 LSN (如 0/16D4F30)"
          value={lsn}
          onChange={(e) => setLsn(e.target.value)}
          style={{
            padding: '0.5rem',
            background: 'var(--bg)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            fontFamily: 'monospace',
            fontSize: '0.875rem',
          }}
        />
        <button
          onClick={fetchWALRecords}
          style={{
            padding: '0.5rem 1rem',
            background: 'var(--accent)',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          刷新
        </button>
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-muted)' }}>加载中...</div>
      ) : records.length > 0 ? (
        <div style={{ overflowX: 'auto' }}>
          <table style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '0.875rem',
            fontFamily: 'monospace',
          }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '0.5rem', textAlign: 'left', color: 'var(--text-muted)' }}>LSN</th>
                <th style={{ padding: '0.5rem', textAlign: 'left', color: 'var(--text-muted)' }}>RMGR</th>
                <th style={{ padding: '0.5rem', textAlign: 'left', color: 'var(--text-muted)' }}>Info</th>
                <th style={{ padding: '0.5rem', textAlign: 'left', color: 'var(--text-muted)' }}>XID</th>
                <th style={{ padding: '0.5rem', textAlign: 'left', color: 'var(--text-muted)' }}>Length</th>
              </tr>
            </thead>
            <tbody>
              {records.map((rec, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '0.5rem', color: 'var(--accent)' }}>{String(rec.lsn ?? '')}</td>
                  <td style={{ padding: '0.5rem' }}>{String(rec.rmgrName ?? '')}</td>
                  <td style={{ padding: '0.5rem' }}>{String(rec.info ?? '')}</td>
                  <td style={{ padding: '0.5rem' }}>{String(rec.xid ?? '')}</td>
                  <td style={{ padding: '0.5rem' }}>{String(rec.recordLen ?? '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{
          padding: '2rem',
          textAlign: 'center',
          color: 'var(--text-muted)',
          background: 'var(--bg-secondary)',
          borderRadius: '8px',
        }}>
          <p>当前未连接到 PostgreSQL，或无 WAL 数据</p>
          <p style={{ fontSize: '0.75rem', marginTop: '0.5rem' }}>
            请在首页连接数据库后执行写操作（如 INSERT）生成 WAL 记录
          </p>
        </div>
      )}
    </div>
  )
}