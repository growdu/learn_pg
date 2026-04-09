import { useState, useEffect } from 'react'

const API_BASE = import.meta.env.VITE_API_URL || ''
const STATUS_COLORS: Record<string, string> = {
  'in-progress': '#7d8590',
  'committed': '#3fb950',
  'aborted': '#f85149',
  'subtrans': '#d29922',
}

const STATUS_LABELS: Record<string, string> = {
  'in-progress': '进行中',
  'committed': '已提交',
  'aborted': '已中止',
  'subtrans': '子事务',
}

export default function CLOGViewer() {
  const [stats, setStats] = useState({ in_progress: 0, committed: 0, aborted: 0, subtrans: 0, total: 0 })
  const [, setLoading] = useState(false)
  const [transactions, setTransactions] = useState<{ xid: number; status: string }[]>([])

  useEffect(() => {
    // Try to fetch CLOG stats when connected
    fetchCLOGStats()
  }, [])

  const fetchCLOGStats = async () => {
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/clog`)
      const data = await res.json()
      if (data.transactions) {
        setTransactions(data.transactions)
        const s = { in_progress: 0, committed: 0, aborted: 0, subtrans: 0, total: data.transactions.length }
        data.transactions.forEach((tx: { status: string }) => {
          if (tx.status === 'in-progress') s.in_progress++
          else if (tx.status === 'committed') s.committed++
          else if (tx.status === 'aborted') s.aborted++
          else if (tx.status === 'subtrans') s.subtrans++
        })
        setStats(s)
      }
    } catch {
      // ignore
    }
    setLoading(false)
  }

  return (
    <div style={{ padding: '1.5rem' }}>
      <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>CLOG 事务状态查看器</h2>

      {/* Stats Summary */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: '0.75rem',
        marginBottom: '1.5rem',
      }}>
        {Object.entries(STATUS_LABELS).map(([key, label]) => {
          const count = stats[key as keyof typeof stats] || 0
          const color = STATUS_COLORS[key] || '#7d8590'
          return (
            <div key={key} style={{
              padding: '0.75rem',
              background: 'var(--bg-secondary)',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              textAlign: 'center',
            }}>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color }}>{count}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>{label}</div>
            </div>
          )
        })}
      </div>

      {/* Grid View */}
      {transactions.length > 0 ? (
        <div style={{
          padding: '1rem',
          background: 'var(--bg-secondary)',
          borderRadius: '8px',
          border: '1px solid var(--border)',
        }}>
          <div style={{ marginBottom: '0.5rem', color: 'var(--text-muted)', fontSize: '0.75rem' }}>
            事务状态矩阵（每个方块 = 1 个事务状态）
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(32, 1fr)', gap: '2px' }}>
            {transactions.map((tx, i) => (
              <div
                key={i}
                title={`XID ${tx.xid}: ${tx.status}`}
                style={{
                  aspectRatio: '1',
                  background: STATUS_COLORS[tx.status] || '#7d8590',
                  borderRadius: '2px',
                }}
              />
            ))}
          </div>
          <div style={{ display: 'flex', gap: '1rem', marginTop: '0.75rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              <span style={{ width: 12, height: 12, background: '#7d8590', borderRadius: 2, display: 'inline-block' }} /> 进行中
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              <span style={{ width: 12, height: 12, background: '#3fb950', borderRadius: 2, display: 'inline-block' }} /> 已提交
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              <span style={{ width: 12, height: 12, background: '#f85149', borderRadius: 2, display: 'inline-block' }} /> 已中止
            </span>
          </div>
        </div>
      ) : (
        <div style={{
          padding: '2rem',
          textAlign: 'center',
          color: 'var(--text-muted)',
          background: 'var(--bg-secondary)',
          borderRadius: '8px',
        }}>
          <p>未获取到 CLOG 数据</p>
          <p style={{ fontSize: '0.75rem', marginTop: '0.5rem' }}>
            CLOG 记录事务提交/中止状态，连接数据库后可查看
          </p>
        </div>
      )}
    </div>
  )
}
