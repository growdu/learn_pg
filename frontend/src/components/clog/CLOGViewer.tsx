import { useEffect, useState } from 'react'
import NodePageHeader from '../common/NodePageHeader'

const API_BASE = import.meta.env.VITE_API_URL || ''

const STATUS_COLORS: Record<string, string> = {
  'in-progress': '#7d8590',
  committed: '#3fb950',
  aborted: '#f85149',
  subtrans: '#d29922',
}

const STATUS_LABELS: Record<string, string> = {
  'in-progress': '进行中',
  committed: '已提交',
  aborted: '已中止',
  subtrans: '子事务',
}

interface CLOGViewerProps {
  onGoBack?: () => void
}

export default function CLOGViewer({ onGoBack }: CLOGViewerProps) {
  const [stats, setStats] = useState({ in_progress: 0, committed: 0, aborted: 0, subtrans: 0, total: 0 })
  const [loading, setLoading] = useState(false)
  const [transactions, setTransactions] = useState<{ xid: number; status: string }[]>([])

  useEffect(() => {
    void fetchCLOGStats()
    const interval = setInterval(() => {
      void fetchCLOGStats()
    }, 5000)
    return () => clearInterval(interval)
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
      setTransactions([])
      setStats({ in_progress: 0, committed: 0, aborted: 0, subtrans: 0, total: 0 })
    }
    setLoading(false)
  }

  return (
    <div style={{ padding: '1.5rem' }}>
      <NodePageHeader title="CLOG 事务状态" source="/api/clog" updatedAtText={new Date().toLocaleTimeString('zh-CN', { hour12: false })} onBack={onGoBack} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem', marginBottom: '1rem' }}>
        {Object.entries(STATUS_LABELS).map(([key, label]) => {
          const count = stats[key as keyof typeof stats] || 0
          const color = STATUS_COLORS[key] || '#7d8590'
          return (
            <div key={key} style={{ padding: '0.75rem', background: 'var(--bg-secondary)', borderRadius: '8px', border: '1px solid var(--border)', textAlign: 'center' }}>
              <div style={{ fontSize: '1.4rem', fontWeight: 700, color }}>{count}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>{label}</div>
            </div>
          )
        })}
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-muted)' }}>加载中...</div>
      ) : transactions.length > 0 ? (
        <div style={{ padding: '1rem', background: 'var(--bg-secondary)', borderRadius: '8px', border: '1px solid var(--border)' }}>
          <div style={{ marginBottom: '0.5rem', color: 'var(--text-muted)', fontSize: '0.75rem' }}>事务状态矩阵（每个方块表示一个事务）</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(32, 1fr)', gap: '2px' }}>
            {transactions.map((tx, i) => (
              <div key={i} title={`XID ${tx.xid}: ${tx.status}`} style={{ aspectRatio: '1', background: STATUS_COLORS[tx.status] || '#7d8590', borderRadius: '2px' }} />
            ))}
          </div>
          <div style={{ display: 'flex', gap: '1rem', marginTop: '0.75rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {Object.entries(STATUS_LABELS).map(([k, v]) => (
              <span key={k} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <span style={{ width: 12, height: 12, background: STATUS_COLORS[k], borderRadius: 2, display: 'inline-block' }} /> {v}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ padding: '1rem', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>
          暂无 CLOG 数据。请先连接节点并执行事务提交/回滚操作。
        </div>
      )}
    </div>
  )
}
