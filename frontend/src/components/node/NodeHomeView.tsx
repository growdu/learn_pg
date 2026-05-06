import type { View } from '../../App'

interface NodeHomeViewProps {
  onNavigate: (view: View) => void
  nodeLabel: string
}

const cards: { view: View; title: string; desc: string }[] = [
  { view: 'sql', title: 'SQL 控制台', desc: '在当前节点执行 SQL，并查看结果与耗时。' },
  { view: 'wal', title: 'WAL 查看', desc: '查看 WAL 记录、LSN 位点与复制相关信息。' },
  { view: 'clog', title: 'CLOG 查看', desc: '查看事务提交/回滚状态与 CLOG 细节。' },
  { view: 'write', title: '写入链路', desc: '查看写入路径各阶段状态与耗时。' },
  { view: 'read', title: '读取链路', desc: '查看读取路径阶段状态与事件明细。' },
  { view: 'transaction', title: '事务链路', desc: '查看事务执行链路阶段与关键细节。' },
  { view: 'buffer', title: 'Buffer 热图', desc: '查看 Buffer 命中、脏页与 pinned 分布。' },
  { view: 'lock', title: '锁等待图', desc: '观察锁等待关系、阻塞链路与热点会话。' },
  { view: 'xact_state', title: '事务状态机', desc: '观察事务状态流转与关键阶段。' },
  { view: 'memory', title: '内存结构', desc: '查看 PGPROC / PGXACT / BufferDesc 等运行时结构。' },
  { view: 'plan', title: '执行计划树', desc: '查看 EXPLAIN 计划树结构与成本信息。' },
]

export default function NodeHomeView({ onNavigate, nodeLabel }: NodeHomeViewProps) {
  return (
    <div style={{ padding: '1rem' }}>
      <h2 style={{ marginTop: 0, marginBottom: '0.35rem' }}>节点主页</h2>
      <div style={{ color: 'var(--text-muted)', fontSize: '0.86rem', marginBottom: '0.85rem' }}>当前节点：{nodeLabel}</div>
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
