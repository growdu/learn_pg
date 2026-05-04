import { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'

export interface TransactionState {
  xid: number
  vxid: string
  state: 'idle' | 'started' | 'in_progress' | 'commit' | 'abort'
  start_time_us?: number
  end_time_us?: number
  lsn?: string
  top_xid?: number
}

const DEMO_STATES: TransactionState[] = [
  { xid: 100, vxid: '3/100', state: 'idle', start_time_us: 0, end_time_us: 1000 },
  { xid: 100, vxid: '3/100', state: 'started', start_time_us: 1000, end_time_us: 1500 },
  { xid: 100, vxid: '3/100', state: 'in_progress', start_time_us: 1500, end_time_us: 8000 },
  { xid: 100, vxid: '3/100', state: 'commit', start_time_us: 8000, end_time_us: 8500, lsn: '0/16D500' },
  { xid: 100, vxid: '3/100', state: 'idle', start_time_us: 8500 },
]

const STATE_COLORS: Record<string, string> = {
  idle: '#7d8590',
  started: '#58a6ff',
  in_progress: '#d29922',
  commit: '#3fb950',
  abort: '#f85149',
}
const STATE_ORDER: TransactionState['state'][] = ['idle', 'started', 'in_progress', 'commit', 'abort']

// ─── Timeline bars sub-view ───────────────────────────────────────────────────

function TransactionTimeline({ states }: { states: TransactionState[] }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!svgRef.current || !containerRef.current || states.length === 0) return
    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const width = containerRef.current.clientWidth
    const rowH = 40
    const labelW = 80
    const marginTop = 10
    const marginBottom = 30
    const height = states.length * rowH + marginTop + marginBottom + 30

    svg.attr('width', width).attr('height', height)

    const allTimes = states.flatMap(s => [s.start_time_us ?? 0, s.end_time_us ?? s.start_time_us ?? 0])
    const tMin = Math.min(...allTimes)
    const tMax = Math.max(...allTimes)
    const tRange = tMax - tMin || 1
    const chartW = width - labelW - 60

    const xScale = d3.scaleLinear().domain([tMin, tMax]).range([0, chartW])

    // Grid
    const ticks = xScale.ticks(6)
    svg.append('g').selectAll('line').data(ticks).enter().append('line')
      .attr('x1', d => labelW + xScale(d)).attr('y1', marginTop)
      .attr('x2', d => labelW + xScale(d)).attr('y2', height - marginBottom - 30)
      .attr('stroke', '#21262d').attr('stroke-width', 1)

    // Time axis
    svg.append('g').selectAll('text').data(ticks).enter().append('text')
      .attr('x', d => labelW + xScale(d)).attr('y', height - 20)
      .attr('text-anchor', 'middle').attr('fill', '#7d8590').attr('font-size', '9px')
      .text(d => d >= 1000 ? `${(d / 1000).toFixed(1)}ms` : `${d}us`)

    // Rows
    states.forEach((txn, i) => {
      const y = marginTop + i * rowH
      const xid = txn.xid
      const bgColor = i % 2 === 0 ? 'transparent' : '#161b22'

      svg.append('rect').attr('x', 0).attr('y', y).attr('width', width).attr('height', rowH).attr('fill', bgColor)

      svg.append('text')
        .attr('x', labelW - 8).attr('y', y + rowH / 2 + 1)
        .attr('text-anchor', 'end').attr('dominant-baseline', 'middle')
        .attr('fill', '#58a6ff').attr('font-size', '11px').attr('font-weight', '600')
        .text(`XID ${xid}`)

      if (txn.start_time_us !== undefined && txn.end_time_us !== undefined) {
        const sx = labelW + xScale(txn.start_time_us)
        const ex = labelW + xScale(txn.end_time_us)
        const bw = Math.max(4, ex - sx)
        const barY = y + (rowH - 22) / 2

        svg.append('rect')
          .attr('x', sx).attr('y', barY).attr('width', bw).attr('height', 22)
          .attr('fill', STATE_COLORS[txn.state]).attr('opacity', 0.85).attr('rx', 3)

        if (bw > 40) {
          svg.append('text')
            .attr('x', sx + bw / 2).attr('y', barY + 11).attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
            .attr('fill', 'white').attr('font-size', '9px').attr('font-weight', '600')
            .text(txn.state === 'in_progress' ? '进行中' : txn.state)
        }

        // Duration
        if (ex - sx > 60) {
          svg.append('text')
            .attr('x', ex + 4).attr('y', barY + 11).attr('dominant-baseline', 'middle')
            .attr('fill', '#7d8590').attr('font-size', '8px')
            .text(`${((txn.end_time_us - txn.start_time_us) / 1000).toFixed(1)}ms`)
        }
      } else {
        svg.append('text')
          .attr('x', labelW + 8).attr('y', y + rowH / 2 + 1).attr('dominant-baseline', 'middle')
          .attr('fill', '#7d8590').attr('font-size', '9px')
          .text('(无时间数据)')
      }
    })

    svg.append('text')
      .attr('x', width - 4).attr('y', height - 20).attr('text-anchor', 'end')
      .attr('fill', '#7d8590').attr('font-size', '9px')
      .text('时间 →')
  }, [states])

  return (
    <div>
      <div style={{ fontSize: '0.8rem', color: 'var(--accent)', fontWeight: 600, marginBottom: '0.5rem' }}>
        事务时间线
      </div>
      <div ref={containerRef} style={{ overflowX: 'auto' }}>
        {states.length === 0 && (
          <div style={{ padding: '1rem', color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center' }}>
            无事务数据
          </div>
        )}
        <svg ref={svgRef} style={{ display: 'block', minWidth: '300px' }} />
      </div>
    </div>
  )
}

// ─── Main State Machine View ──────────────────────────────────────────────────

export default function TransactionStateView({ transactions }: TransactionStateViewProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [selected] = useState<TransactionState | null>(null)
  const [animationPlaying, setAnimationPlaying] = useState(true)
  const [currentStep, setCurrentStep] = useState(0)
  const [viewMode, setViewMode] = useState<'fsm' | 'timeline'>('fsm')
  const data = transactions || DEMO_STATES

  useEffect(() => {
    if (!transactions || transactions.length === 0) {
      setAnimationPlaying(true)
      return
    }
    const latest = transactions[transactions.length - 1]
    const nextStep = Math.max(0, STATE_ORDER.indexOf(latest.state))
    setAnimationPlaying(false)
    setCurrentStep(nextStep)
  }, [transactions])

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
    states.forEach((s, i) => { statePositions[s] = 40 + i * stateWidth })

    const centerY = height / 2

    const transitions = [
      { from: 'idle', to: 'started', label: 'BEGIN' },
      { from: 'started', to: 'in_progress', label: '' },
      { from: 'in_progress', to: 'commit', label: 'COMMIT' },
      { from: 'in_progress', to: 'abort', label: 'ROLLBACK' },
      { from: 'commit', to: 'idle', label: '' },
      { from: 'abort', to: 'idle', label: '' },
    ]

    svg.append('g')
      .selectAll('path').data(transitions).enter().append('path')
      .attr('d', (d) => {
        const sx = statePositions[d.from]!
        const tx = statePositions[d.to]!
        const midX = (sx + tx) / 2
        const midY = centerY - 30
        return `M ${sx},${centerY} Q ${midX},${midY} ${tx},${centerY}`
      })
      .attr('fill', 'none').attr('stroke', '#30363d').attr('stroke-width', 1.5)
      .attr('stroke-dasharray', '4,2')

    states.forEach((state) => {
      const x = statePositions[state]!
      const isActive = currentStep >= states.indexOf(state)
      const isCurrent = currentStep === states.indexOf(state)

      svg.append('circle')
        .attr('cx', x).attr('cy', centerY)
        .attr('r', isCurrent ? 28 : 24)
        .attr('fill', STATE_COLORS[state])
        .attr('stroke', isCurrent ? '#fff' : '#30363d')
        .attr('stroke-width', isCurrent ? 3 : 1)
        .attr('opacity', isActive ? 1 : 0.4)

      svg.append('text')
        .attr('x', x).attr('y', centerY + 45)
        .attr('text-anchor', 'middle').attr('fill', isActive ? '#e6edf3' : '#7d8590')
        .attr('font-size', '10px').attr('font-weight', '500')
        .text(state === 'in_progress' ? 'in-progress' : state.toUpperCase())

      const stateNames: Record<string, string> = {
        idle: '空闲', started: '已启动', in_progress: '进行中', commit: '已提交', abort: '已回滚',
      }
      svg.append('text')
        .attr('x', x).attr('y', centerY + 60)
        .attr('text-anchor', 'middle').attr('fill', '#7d8590').attr('font-size', '9px')
        .text(stateNames[state])
    })

    if (animationPlaying) {
      const activeState = states[currentStep] || 'idle'
      const activeX = statePositions[activeState]!
      const dot = svg.append('circle')
        .attr('cx', activeX).attr('cy', centerY).attr('r', 6)
        .attr('fill', '#fff').attr('opacity', 0.8)

      const pulse = () => {
        dot.transition().duration(500).attr('r', 10).attr('opacity', 0.3)
          .transition().duration(500).attr('r', 6).attr('opacity', 0.8)
          .on('end', pulse)
      }
      if (currentStep < states.length - 1) pulse()
    }
  }, [data, currentStep, animationPlaying, selected])

  useEffect(() => {
    if (!animationPlaying) return
    const interval = setInterval(() => {
      setCurrentStep((prev) => {
        if (prev >= 4) return 0
        return prev + 1
      })
    }, 1500)
    return () => clearInterval(interval)
  }, [animationPlaying])

  return (
    <div style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.25rem' }}>事务状态机</h2>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {/* View mode */}
          <div style={{ display: 'flex', borderRadius: '4px', overflow: 'hidden', border: '1px solid var(--border)' }}>
            {(['fsm', 'timeline'] as const).map(mode => (
              <button key={mode} onClick={() => setViewMode(mode)}
                style={{
                  padding: '0.25rem 0.6rem',
                  background: viewMode === mode ? 'var(--accent)' : 'var(--bg-tertiary)',
                  color: viewMode === mode ? '#fff' : 'var(--text-muted)',
                  border: 'none', cursor: 'pointer', fontSize: '0.75rem',
                }}>
                {mode === 'fsm' ? '状态机' : '时间线'}
              </button>
            ))}
          </div>
          <button onClick={() => setAnimationPlaying(!animationPlaying)} style={{
            padding: '0.25rem 0.75rem',
            background: animationPlaying ? 'var(--bg-tertiary)' : 'var(--accent)',
            color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '4px',
            cursor: 'pointer', fontSize: '0.75rem',
          }}>
            {animationPlaying ? '暂停' : '播放'}
          </button>
          <button onClick={() => setCurrentStep(0)} style={{
            padding: '0.25rem 0.75rem', background: 'var(--bg-tertiary)', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: '4px', cursor: 'pointer', fontSize: '0.75rem',
          }}>
            重置
          </button>
        </div>
      </div>

      {viewMode === 'fsm' ? (
        <div ref={containerRef} style={{
          background: 'var(--bg-secondary)', borderRadius: '8px', border: '1px solid var(--border)',
          padding: '1rem', overflowX: 'auto',
        }}>
          <svg ref={svgRef} style={{ display: 'block' }} />
        </div>
      ) : (
        <div style={{
          background: 'var(--bg-secondary)', borderRadius: '8px', border: '1px solid var(--border)',
          padding: '1rem', marginBottom: '1rem', overflowX: 'auto',
        }}>
          <TransactionTimeline states={data} />
        </div>
      )}

      {/* Legend */}
      <div style={{ display: 'flex', gap: '1rem', marginTop: '0.75rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
        <span>🔵 空闲</span><span>🔵 已启动</span><span>🟡 进行中</span><span>🟢 已提交</span><span>🔴 已回滚</span>
      </div>

      {/* Lifecycle summary */}
      <div style={{
        marginTop: '1rem', padding: '1rem', background: 'var(--bg)', borderRadius: '8px', border: '1px solid var(--border)',
      }}>
        <h3 style={{ fontSize: '0.875rem', marginBottom: '0.75rem' }}>事务生命周期</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '0.5rem', fontSize: '0.75rem' }}>
          {[
            { s: 'idle', zh: '空闲' }, { s: 'started', zh: '已启动' },
            { s: 'in_progress', zh: '进行中' }, { s: 'commit', zh: '已提交' }, { s: 'abort', zh: '已回滚' },
          ].map(({ s, zh }) => (
            <div key={s} style={{ textAlign: 'center', padding: '0.5rem', background: 'var(--bg-secondary)', borderRadius: '4px' }}>
              <div style={{ color: STATE_COLORS[s] }}>{s}</div>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.625rem' }}>{zh}</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center' }}>
          状态流转: idle → started → in_progress → (commit | abort) → idle
        </div>
      </div>
    </div>
  )
}
