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

// Demo transaction states for visualization
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

interface TransactionStateViewProps {
  transactions?: TransactionState[]
}

export default function TransactionStateView({ transactions }: TransactionStateViewProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [selected] = useState<TransactionState | null>(null)
  const [animationPlaying, setAnimationPlaying] = useState(true)
  const [currentStep, setCurrentStep] = useState(0)
  const data = transactions || DEMO_STATES

  useEffect(() => {
    if (!svgRef.current || !containerRef.current) return

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const width = containerRef.current.clientWidth
    const height = 180

    svg.attr('width', width).attr('height', height)

    // State machine positions
    const states = ['idle', 'started', 'in_progress', 'commit', 'abort'] as const
    const stateWidth = (width - 60) / (states.length - 1)
    const statePositions: Record<string, number> = {}
    states.forEach((s, i) => {
      statePositions[s] = 40 + i * stateWidth
    })

    const centerY = height / 2

    // Draw edges (transitions)
    const transitions = [
      { from: 'idle', to: 'started', label: 'BEGIN' },
      { from: 'started', to: 'in_progress', label: '' },
      { from: 'in_progress', to: 'commit', label: 'COMMIT' },
      { from: 'in_progress', to: 'abort', label: 'ROLLBACK' },
      { from: 'commit', to: 'idle', label: '' },
      { from: 'abort', to: 'idle', label: '' },
    ]

    svg.append('g')
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

    // Draw state nodes
    states.forEach((state) => {
      const x = statePositions[state]!
      const isActive = currentStep >= states.indexOf(state)
      const isCurrent = currentStep === states.indexOf(state)

      // Node circle
      svg.append('circle')
        .attr('cx', x)
        .attr('cy', centerY)
        .attr('r', isCurrent ? 28 : 24)
        .attr('fill', STATE_COLORS[state])
        .attr('stroke', isCurrent ? '#fff' : '#30363d')
        .attr('stroke-width', isCurrent ? 3 : 1)
        .attr('opacity', isActive ? 1 : 0.4)

      // State label
      svg.append('text')
        .attr('x', x)
        .attr('y', centerY + 45)
        .attr('text-anchor', 'middle')
        .attr('fill', isActive ? '#e6edf3' : '#7d8590')
        .attr('font-size', '10px')
        .attr('font-weight', '500')
        .text(state === 'in_progress' ? 'in-progress' : state.toUpperCase())

      // State name (below)
      const stateNames: Record<string, string> = {
        idle: '空闲',
        started: '已启动',
        in_progress: '进行中',
        commit: '已提交',
        abort: '已回滚',
      }
      svg.append('text')
        .attr('x', x)
        .attr('y', centerY + 60)
        .attr('text-anchor', 'middle')
        .attr('fill', '#7d8590')
        .attr('font-size', '9px')
        .text(stateNames[state])
    })

    // Draw active transaction indicator
    const activeState = states[currentStep] || 'idle'
    const activeX = statePositions[activeState]!

    // Animated dot on current state
    if (animationPlaying) {
      const dot = svg.append('circle')
        .attr('cx', activeX)
        .attr('cy', centerY)
        .attr('r', 6)
        .attr('fill', '#fff')
        .attr('opacity', 0.8)

      // Pulse animation
      const pulse = () => {
        dot
          .transition()
          .duration(500)
          .attr('r', 10)
          .attr('opacity', 0.3)
          .transition()
          .duration(500)
          .attr('r', 6)
          .attr('opacity', 0.8)
          .on('end', pulse)
      }
      if (currentStep < states.length - 1) {
        pulse()
      }
    }

    // Transaction info panel
    if (selected) {
      const infoX = width - 150
      const infoY = 20

      svg.append('rect')
        .attr('x', infoX)
        .attr('y', infoY)
        .attr('width', 140)
        .attr('height', 70)
        .attr('fill', '#21262d')
        .attr('stroke', '#30363d')
        .attr('rx', 6)

      svg.append('text')
        .attr('x', infoX + 10)
        .attr('y', infoY + 20)
        .attr('fill', '#7d8590')
        .attr('font-size', '10px')
        .text(`XID: ${selected.xid}`)

      svg.append('text')
        .attr('x', infoX + 10)
        .attr('y', infoY + 35)
        .attr('fill', '#7d8590')
        .attr('font-size', '10px')
        .text(`VXID: ${selected.vxid}`)

      svg.append('text')
        .attr('x', infoX + 10)
        .attr('y', infoY + 50)
        .attr('fill', STATE_COLORS[selected.state])
        .attr('font-size', '10px')
        .attr('font-weight', '600')
        .text(`状态: ${selected.state}`)
    }
  }, [data, currentStep, animationPlaying, selected])

  // Animation effect
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
          <button
            onClick={() => setAnimationPlaying(!animationPlaying)}
            style={{
              padding: '0.25rem 0.75rem',
              background: animationPlaying ? 'var(--bg-tertiary)' : 'var(--accent)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '0.75rem',
            }}
          >
            {animationPlaying ? '暂停' : '播放'}
          </button>
          <button
            onClick={() => setCurrentStep(0)}
            style={{
              padding: '0.25rem 0.75rem',
              background: 'var(--bg-tertiary)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '0.75rem',
            }}
          >
            重置
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        style={{
          background: 'var(--bg-secondary)',
          borderRadius: '8px',
          border: '1px solid var(--border)',
          padding: '1rem',
          overflowX: 'auto',
        }}
      >
        <svg ref={svgRef} style={{ display: 'block' }} />
      </div>

      {/* Legend */}
      <div style={{
        display: 'flex',
        gap: '1rem',
        marginTop: '0.75rem',
        fontSize: '0.75rem',
        color: 'var(--text-muted)',
      }}>
        <span>🔵 空闲</span>
        <span>🔵 已启动</span>
        <span>🟡 进行中</span>
        <span>🟢 已提交</span>
        <span>🔴 已回滚</span>
        <span>| 点击节点查看详情</span>
      </div>

      {/* State transitions table */}
      <div style={{
        marginTop: '1rem',
        padding: '1rem',
        background: 'var(--bg)',
        borderRadius: '8px',
        border: '1px solid var(--border)',
      }}>
        <h3 style={{ fontSize: '0.875rem', marginBottom: '0.75rem' }}>事务生命周期</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '0.5rem', fontSize: '0.75rem' }}>
          <div style={{ textAlign: 'center', padding: '0.5rem', background: 'var(--bg-secondary)', borderRadius: '4px' }}>
            <div style={{ color: '#7d8590' }}>idle</div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.625rem' }}>空闲</div>
          </div>
          <div style={{ textAlign: 'center', padding: '0.5rem', background: 'var(--bg-secondary)', borderRadius: '4px' }}>
            <div style={{ color: '#58a6ff' }}>started</div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.625rem' }}>已启动</div>
          </div>
          <div style={{ textAlign: 'center', padding: '0.5rem', background: 'var(--bg-secondary)', borderRadius: '4px' }}>
            <div style={{ color: '#d29922' }}>in_progress</div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.625rem' }}>进行中</div>
          </div>
          <div style={{ textAlign: 'center', padding: '0.5rem', background: 'var(--bg-secondary)', borderRadius: '4px' }}>
            <div style={{ color: '#3fb950' }}>commit</div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.625rem' }}>已提交</div>
          </div>
          <div style={{ textAlign: 'center', padding: '0.5rem', background: 'var(--bg-secondary)', borderRadius: '4px' }}>
            <div style={{ color: '#f85149' }}>abort</div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.625rem' }}>已回滚</div>
          </div>
        </div>
        <div style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center' }}>
          状态流转: idle → started → in_progress → (commit | abort) → idle
        </div>
      </div>
    </div>
  )
}