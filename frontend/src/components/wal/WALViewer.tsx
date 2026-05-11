import { useEffect, useState, type CSSProperties } from 'react'
import NodePageHeader from '../common/NodePageHeader'

const API_BASE = import.meta.env.VITE_API_URL || ''

interface WALViewerProps {
  onGoBack?: () => void
}

export default function WALViewer({ onGoBack }: WALViewerProps) {
  const [records, setRecords] = useState<Record<string, unknown>[]>([])
  const [loading, setLoading] = useState(false)
  const [lsn, setLsn] = useState('')

  useEffect(() => {
    void fetchWALRecords()
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
      <NodePageHeader title="WAL 记录查看" source="/api/wal" updatedAtText={new Date().toLocaleTimeString('zh-CN', { hour12: false })} onBack={onGoBack} />

      <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem', alignItems: 'center' }}>
        <input
          type="text"
          placeholder="起始 LSN（例如 0/16D4F30）"
          value={lsn}
          onChange={(e) => setLsn(e.target.value)}
          style={{ padding: '0.5rem', background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.875rem', minWidth: '260px' }}
        />
        <button onClick={() => void fetchWALRecords()} style={{ padding: '0.5rem 1rem', background: 'var(--accent)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
          刷新
        </button>
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-muted)' }}>加载中...</div>
      ) : records.length > 0 ? (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem', fontFamily: 'monospace' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={th}>LSN</th>
                <th style={th}>RMGR</th>
                <th style={th}>Operation</th>
                <th style={th}>Info</th>
                <th style={th}>XID</th>
                <th style={th}>Length</th>
                <th style={th}>Blocks</th>
              </tr>
            </thead>
            <tbody>
              {records.map((rec, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ ...td, color: 'var(--accent)' }}>{String(rec.lsn ?? '')}</td>
                  <td style={td}>{String(rec.rmgrName ?? '')}</td>
                  <td style={td}>{String(rec.operation ?? '')}</td>
                  <td style={td}>{String(rec.info ?? '')}</td>
                  <td style={td}>{String(rec.xid ?? '')}</td>
                  <td style={td}>{String(rec.recordLen ?? '')} / {String(rec.payloadLen ?? 0)}</td>
                  <td style={td}>{formatBlocks(rec.blocks)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ padding: '1rem', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>
          暂无 WAL 数据。请先连接节点并执行写入 SQL（如 INSERT/UPDATE/DELETE）。
        </div>
      )}
    </div>
  )
}

const th: CSSProperties = { padding: '0.5rem', textAlign: 'left', color: 'var(--text-muted)' }
const td: CSSProperties = { padding: '0.5rem' }

function formatBlocks(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return '-'
  return value
    .slice(0, 2)
    .map((block) => {
      const ref = block as Record<string, unknown>
      const rel = ref.relNode != null ? `rel ${String(ref.relNode)}` : 'rel ?'
      const blk = ref.blockNum != null ? `blk ${String(ref.blockNum)}` : 'blk ?'
      return `${rel}:${blk}`
    })
    .join(', ')
}
