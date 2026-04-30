import type { View } from '../../App'

interface NodeHomeViewProps {
  onNavigate: (view: View) => void
  nodeLabel: string
}

const cards: { view: View; title: string; desc: string }[] = [
  { view: 'sql', title: 'SQL 控制台', desc: '在当前节点执行 SQL 并查看结果。' },
  { view: 'wal', title: 'WAL 查看', desc: '查看 WAL 记录与复制相关细节。' },
  { view: 'clog', title: 'CLOG 查看', desc: '查看 pg_xact 中事务提交/回滚状态。' },
  { view: 'lock', title: '锁等待图', desc: '观察锁等待与争用关系。' },
  { view: 'xact_state', title: '事务状态机', desc: '观察事务状态流转。' },
  { view: 'memory', title: '内存结构', desc: '查看后端/内存相关运行态数据。' },
]

export default function NodeHomeView({ onNavigate, nodeLabel }: NodeHomeViewProps) {
  return (
    <div style={{ padding: '1rem' }}>
      <h2 style={{ marginTop: 0, marginBottom: '0.35rem' }}>节点主页</h2>
      <div style={{ color: 'var(--text-muted)', fontSize: '0.86rem', marginBottom: '0.85rem' }}>
        当前节点：{nodeLabel}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))', gap: '0.75rem' }}>
        {cards.map((card) => (
          <button
            key={card.view}
            onClick={() => onNavigate(card.view)}
            style={{
              textAlign: 'left',
              border: '1px solid var(--border)',
              background: 'var(--bg-secondary)',
              borderRadius: '10px',
              padding: '0.8rem',
              color: 'var(--text)',
              cursor: 'pointer',
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: '0.3rem' }}>{card.title}</div>
            <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>{card.desc}</div>
          </button>
        ))}
      </div>
    </div>
  )
}
