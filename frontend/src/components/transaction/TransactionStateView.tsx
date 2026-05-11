import { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'
import NodePageHeader from '../common/NodePageHeader'

export interface TransactionState {
  xid: number
  vxid: string
  state: 'idle' | 'started' | 'in_progress' | 'commit' | 'abort'
  start_time_us?: number
  end_time_us?: number
  lsn?: string
  top_xid?: number
}

const STATE_COLORS: Record<string, string> = {
  idle: '#7d8590',
  started: '#58a6ff',
  in_progress: '#d29922',
  commit: '#3fb950',
  abort: '#f85149',
}
const STATE_ORDER: TransactionState['state'][] = ['idle', 'started', 'in_progress', 'commit', 'abort']

export interface TransactionStateViewProps {
  transactions?: TransactionState[]
  onGoBack?: () => void
}

export default function TransactionStateView({ transactions, onGoBack }: TransactionStateViewProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [viewMode, setViewMode] = useState<'fsm' | 'table'>('fsm')
  const data = transactions ?? []

  const currentState = data.length > 0 ? data[data.length - 1].state : 'idle'
  const currentStep = Math.max(0, STATE_ORDER.indexOf(currentState))

  useEffect(() => {
    if (!svgRef.current || !containerRef.current) return
    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const width = containerRef.current.clientWidth
    const height = 180
    svg.attr('width', width).attr('height', height)

    const states = STATE_ORDER
    const stateWidth = (width - 60) / (states.length - 1)
    const statePositions: Record<string, number> = {}
    states.forEach((s, i) => {
      statePositions[s] = 40 + i * stateWidth
    })

    const centerY = height / 2

    const transitions = [
      { from: 'idle', to: 'started' },
      { from: 'started', to: 'in_progress' },
      { from: 'in_progress', to: 'commit' },
      { from: 'in_progress', to: 'abort' },
      { from: 'commit', to: 'idle' },
      { from: 'abort', to: 'idle' },
    ]

    svg
      .append('g')
      .selectAll('path')
      .data(transitions)
      .enter()
      .append('path')
      .attr('d', (d) => {
        const sx = statePositions[d.from]!
        const tx = statePositions[d.to]!
        const midX = (sx + tx) / 2
        const midY = centerY - 30
        return `M ${sx},${centerY} Q ${midX},${midY} ${tx},${centerY}`
      })
      .attr('fill', 'none')
      .attr('stroke', '#30363d')
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', '4,2')

    const stateNames: Record<string, string> = {
      idle: '空闲',
      started: '已开始',
      in_progress: '进行中',
      commit: '已提交',
      abort: '已回滚',
    }

    states.forEach((state) => {
      const x = statePositions[state]!
      const isActive = currentStep >= states.indexOf(state)
      const isCurrent = currentStep === states.indexOf(state)

      svg
        .append('circle')
        .attr('cx', x)
        .attr('cy', centerY)
        .attr('r', isCurrent ? 28 : 24)
        .attr('fill', STATE_COLORS[state])
        .attr('stroke', isCurrent ? '#fff' : '#30363d')
        .attr('stroke-width', isCurrent ? 3 : 1)
        .attr('opacity', isActive ? 1 : 0.35)

      svg
        .append('text')
        .attr('x', x)
        .attr('y', centerY + 45)
        .attr('text-anchor', 'middle')
        .attr('fill', isActive ? '#e6edf3' : '#7d8590')
        .attr('font-size', '10px')
        .text(state.toUpperCase())

      svg
        .append('text')
        .attr('x', x)
        .attr('y', centerY + 60)
        .attr('text-anchor', 'middle')
        .attr('fill', '#7d8590')
        .attr('font-size', '9px')
        .text(stateNames[state])
    })
  }, [currentStep])

  return (
    <div style={{ padding: '1.5rem' }}>
      <NodePageHeader
        title="事务状态机"
        source="/api/snapshot 或 xact_state 事件"
        updatedAtText={new Date().toLocaleTimeString('zh-CN', { hour12: false })}
        rightSlot={
          <div style={{ display: 'flex', borderRadius: '4px', overflow: 'hidden', border: '1px solid var(--border)' }}>
            {(['fsm', 'table'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                style={{
                  padding: '0.25rem 0.6rem',
                  background: viewMode === mode ? 'var(--accent)' : 'var(--bg-tertiary)',
                  color: viewMode === mode ? '#fff' : 'var(--text-muted)',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '0.75rem',
                }}
              >
                {mode === 'fsm' ? '状态图' : '表格'}
              </button>
            ))}
          </div>
        }
        onBack={onGoBack}
      />

      {data.length === 0 && (
        <div style={{ padding: '1rem', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>
          暂无事务状态数据，请先执行事务相关 SQL。
        </div>
      )}

      {data.length > 0 && viewMode === 'fsm' && (
        <div ref={containerRef} style={{ background: 'var(--bg-secondary)', borderRadius: '8px', border: '1px solid var(--border)', padding: '1rem', overflowX: 'auto' }}>
          <svg ref={svgRef} style={{ display: 'block' }} />
        </div>
      )}

      {data.length > 0 && viewMode === 'table' && (
        <div style={{ border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
            <thead>
              <tr style={{ background: 'var(--bg-secondary)' }}>
                {['XID', 'VXID', '状态', '开始(us)', '结束(us)', 'LSN'].map((h) => (
                  <th key={h} style={{ textAlign: 'left', padding: '0.5rem', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((tx) => (
                <tr key={`${tx.xid}-${tx.vxid}`}>
                  <td style={{ padding: '0.45rem 0.5rem', fontFamily: 'monospace' }}>{tx.xid || '-'}</td>
                  <td style={{ padding: '0.45rem 0.5rem', fontFamily: 'monospace' }}>{tx.vxid || '-'}</td>
                  <td style={{ padding: '0.45rem 0.5rem', color: STATE_COLORS[tx.state] }}>{tx.state}</td>
                  <td style={{ padding: '0.45rem 0.5rem', fontFamily: 'monospace' }}>{tx.start_time_us ?? '-'}</td>
                  <td style={{ padding: '0.45rem 0.5rem', fontFamily: 'monospace' }}>{tx.end_time_us ?? '-'}</td>
                  <td style={{ padding: '0.45rem 0.5rem', fontFamily: 'monospace' }}>{tx.lsn ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
