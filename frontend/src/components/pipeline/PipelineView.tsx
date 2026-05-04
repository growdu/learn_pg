import { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'

export interface PipelineStage {
  id: string
  name: string
  label: string
  duration_us: number
  start_us: number
  end_us: number
  details: Record<string, string | number>
  status: 'pending' | 'active' | 'done' | 'error'
  color?: string
}

interface PipelineViewProps {
  type?: 'write' | 'read' | 'transaction'
  stages?: PipelineStage[]
}

// Default stages for write pipeline
const DEFAULT_WRITE_STAGES: PipelineStage[] = [
  { id: 'parse', name: 'Parser', label: 'SQL 解析', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#58a6ff' },
  { id: 'bind', name: 'Binder', label: '参数绑定', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#bc8cff' },
  { id: 'plan', name: 'Planner', label: '执行计划', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#d29922' },
  { id: 'exec_start', name: 'ExecutorStart', label: '执行器启动', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#3fb950' },
  { id: 'tuple_form', name: 'heap_form_tuple', label: '元组构建', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#f0883e' },
  { id: 'buf_alloc', name: 'BufferAlloc', label: 'Buffer 分配', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#f85149' },
  { id: 'wal_insert', name: 'XLogInsert', label: 'WAL 写入', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#ff7b72' },
  { id: 'page_modify', name: 'PageAddItem', label: '数据页修改', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#a371f7' },
  { id: 'clog_update', name: 'TransactionLogUpdate', label: 'CLOG 更新', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#7ee787' },
  { id: 'commit', name: 'Commit', label: '提交完成', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#39d353' },
]

const TYPE_CONFIG: Record<string, { title: string; stages: PipelineStage[] }> = {
  write: { title: '数据写入 Pipeline', stages: DEFAULT_WRITE_STAGES },
  read: {
    title: '数据读取 Pipeline',
    stages: [
      { id: 'parse', name: 'Parser', label: 'SQL 解析', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#58a6ff' },
      { id: 'plan', name: 'Planner', label: '生成执行计划', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#d29922' },
      { id: 'exec_start', name: 'ExecutorStart', label: '执行器启动', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#3fb950' },
      { id: 'seq_scan', name: 'SeqScan', label: '顺序扫描', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#f0883e' },
      { id: 'buf_pin', name: 'BufferPin', label: 'Buffer Pin', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#f85149' },
      { id: 'mvcc', name: 'HeapTupleSatisfiesMVCC', label: 'MVCC 可见性判断', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#bc8cff' },
      { id: 'result', name: 'Result', label: '返回结果', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#39d353' },
    ],
  },
  transaction: {
    title: '事务执行 Pipeline',
    stages: [
      { id: 'begin', name: 'BeginTransactionBlock', label: '事务开始', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#58a6ff' },
      { id: 'xid_assign', name: 'TransactionIdAssign', label: 'XID 分配', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#d29922' },
      { id: 'sql_exec', name: 'SQLExecution', label: 'SQL 执行', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#3fb950' },
      { id: 'lock_acquire', name: 'LockAcquire', label: '锁获取', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#f85149' },
      { id: 'wal_write', name: 'XLogInsert', label: 'WAL 写入', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#ff7b72' },
      { id: 'clog_commit', name: 'TransactionLogUpdate', label: 'CLOG 提交', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#7ee787' },
      { id: 'commit', name: 'CommitTransaction', label: '事务提交', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#39d353' },
    ],
  },
}

// ─── Gantt Chart Sub-view ───────────────────────────────────────────────────────

function PipelineGantt({ stages }: { stages: PipelineStage[] }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const doneStages = stages.filter(s => s.duration_us > 0)
  const totalTime = doneStages.length > 0
    ? Math.max(...doneStages.map(s => s.end_us))
    : 0

  useEffect(() => {
    if (!svgRef.current || !containerRef.current) return
    if (doneStages.length === 0) return

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const width = containerRef.current.clientWidth
    const rowH = 28
    const labelW = 140
    const chartW = width - labelW - 60
    const marginTop = 10
    const marginBottom = 30

    const height = doneStages.length * rowH + marginTop + marginBottom
    svg.attr('width', width).attr('height', height)

    // Time axis
    const xScale = d3.scaleLinear().domain([0, totalTime || 1]).range([0, chartW])

    // Vertical grid lines
    const tickCount = Math.min(8, Math.ceil(totalTime / 1000))
    const ticks = xScale.ticks(tickCount)
    svg.append('g')
      .selectAll('line')
      .data(ticks)
      .enter()
      .append('line')
      .attr('x1', d => labelW + xScale(d))
      .attr('y1', marginTop)
      .attr('x2', d => labelW + xScale(d))
      .attr('y2', height - marginBottom)
      .attr('stroke', '#21262d')
      .attr('stroke-width', 1)

    // Time axis labels
    svg.append('g')
      .selectAll('text')
      .data(ticks)
      .enter()
      .append('text')
      .attr('x', d => labelW + xScale(d))
      .attr('y', height - 10)
      .attr('text-anchor', 'middle')
      .attr('fill', '#7d8590')
      .attr('font-size', '9px')
      .text(d => totalTime >= 1000 ? `${(d / 1000).toFixed(1)}ms` : `${d}us`)

    // Axis label
    svg.append('text')
      .attr('x', width - 4)
      .attr('y', height - 10)
      .attr('text-anchor', 'end')
      .attr('fill', '#7d8590')
      .attr('font-size', '9px')
      .text('耗时 →')

    // Bars
    const barH = 18
    doneStages.forEach((stage, i) => {
      const y = marginTop + i * rowH
      const barX = labelW + xScale(stage.start_us)
      const barW = Math.max(2, xScale(stage.duration_us))
      const fillColor = stage.status === 'error' ? '#f85149' : stage.color || '#3fb950'
      const isSelected = false

      // Row background
      svg.append('rect')
        .attr('x', 0).attr('y', y)
        .attr('width', width).attr('height', rowH)
        .attr('fill', i % 2 === 0 ? 'transparent' : '#161b22')
        .attr('rx', 0)

      // Stage name label
      svg.append('text')
        .attr('x', labelW - 8)
        .attr('y', y + rowH / 2 + 1)
        .attr('text-anchor', 'end')
        .attr('dominant-baseline', 'middle')
        .attr('fill', fillColor)
        .attr('font-size', '10px')
        .attr('font-weight', '500')
        .text(stage.label.length > 18 ? stage.label.substring(0, 16) + '..' : stage.label)

      // Bar
      svg.append('rect')
        .attr('x', barX)
        .attr('y', y + (rowH - barH) / 2)
        .attr('width', barW)
        .attr('height', barH)
        .attr('fill', fillColor)
        .attr('opacity', 0.85)
        .attr('rx', 3)

      // Duration label inside bar
      if (barW > 40) {
        svg.append('text')
          .attr('x', barX + barW / 2)
          .attr('y', y + rowH / 2 + 1)
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'middle')
          .attr('fill', 'white')
          .attr('font-size', '9px')
          .attr('font-weight', '600')
          .text(stage.duration_us >= 1000
            ? `${(stage.duration_us / 1000).toFixed(1)}ms`
            : `${stage.duration_us}us`)
      }

      // Total time label after bar
      if (stage.end_us > 0) {
        svg.append('text')
          .attr('x', labelW + xScale(stage.end_us) + 4)
          .attr('y', y + rowH / 2 + 1)
          .attr('dominant-baseline', 'middle')
          .attr('fill', '#7d8590')
          .attr('font-size', '8px')
          .text(`${(stage.end_us / 1000).toFixed(1)}ms`)
      }
    })

    // Total bar
    const totalY = height - marginBottom + 4
    svg.append('rect')
      .attr('x', labelW)
      .attr('y', totalY)
      .attr('width', chartW)
      .attr('height', 3)
      .attr('fill', '#30363d')
      .attr('rx', 1)
    svg.append('text')
      .attr('x', labelW + chartW + 4)
      .attr('y', totalY + 3)
      .attr('fill', '#7d8590')
      .attr('font-size', '9px')
      .text(`总计: ${(totalTime / 1000).toFixed(2)}ms`)
  }, [doneStages, totalTime])

  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      {doneStages.length === 0 && (
        <div style={{ padding: '1rem', color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center' }}>
          运行演示或传入实际数据后显示 Gantt 图
        </div>
      )}
      <svg ref={svgRef} style={{ display: 'block', width: '100%' }} />
    </div>
  )
}

// ─── Node view (simplified pipeline with step numbers) ────────────────────────

export default function PipelineView({ type = 'write', stages }: PipelineViewProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [selectedStage, setSelectedStage] = useState<PipelineStage | null>(null)
  const [playing, setPlaying] = useState(false)
  const [currentStep, setCurrentStep] = useState(0)
  const [speed, setSpeed] = useState(1)
  const [viewMode, setViewMode] = useState<'nodes' | 'gantt'>('nodes')
  const config = TYPE_CONFIG[type] || TYPE_CONFIG.write
  const displayStages = stages || config.stages

  useEffect(() => {
    if (!svgRef.current || !containerRef.current) return

    const container = containerRef.current
    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const width = container.clientWidth
    const height = 120
    const nodeWidth = Math.min(80, (width - 120) / Math.max(displayStages.length - 1, 1))
    const centerY = 60

    svg.attr('width', width).attr('height', height)

    // Draw connecting lines between nodes
    for (let i = 0; i < displayStages.length - 1; i++) {
      const x1 = 60 + i * nodeWidth + nodeWidth / 2
      const x2 = 60 + (i + 1) * nodeWidth - nodeWidth / 2

      svg.append('line')
        .attr('x1', x1).attr('y1', centerY)
        .attr('x2', x2).attr('y2', centerY)
        .attr('stroke', '#30363d')
        .attr('stroke-width', 2)

      svg.append('polygon')
        .attr('points', `${x2},${centerY} ${x2 - 8},${centerY - 5} ${x2 - 8},${centerY + 5}`)
        .attr('fill', '#30363d')
    }

    // Draw nodes
    displayStages.forEach((stage, i) => {
      const x = 60 + i * nodeWidth
      const isSelected = selectedStage?.id === stage.id
      const isPast = stage.status === 'done'
      const isActive = stage.status === 'active' || (playing && i === currentStep)
      const fillColor = stage.status === 'error' ? '#f85149'
        : isPast ? (stage.color || '#3fb950')
        : isActive ? '#58a6ff'
        : '#30363d'
      const strokeColor = isSelected ? '#58a6ff' : fillColor

      svg.append('circle')
        .attr('cx', x + nodeWidth / 2)
        .attr('cy', centerY)
        .attr('r', isActive ? 20 : 16)
        .attr('fill', fillColor)
        .attr('stroke', strokeColor)
        .attr('stroke-width', isSelected ? 3 : 2)
        .attr('cursor', 'pointer')
        .on('click', () => setSelectedStage(isSelected ? null : stage))
        .on('mouseover', function () {
          d3.select(this).attr('r', isActive ? 22 : 18)
        })
        .on('mouseout', function () {
          d3.select(this).attr('r', isActive ? 20 : 16)
        })

      svg.append('text')
        .attr('x', x + nodeWidth / 2)
        .attr('y', centerY + 1)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .attr('fill', 'white')
        .attr('font-size', '11px')
        .attr('font-weight', '700')
        .text(i + 1)

      svg.append('text')
        .attr('x', x + nodeWidth / 2)
        .attr('y', centerY + 30)
        .attr('text-anchor', 'middle')
        .attr('fill', isPast || isActive ? '#e6edf3' : '#7d8590')
        .attr('font-size', '10px')
        .attr('font-weight', isSelected ? '700' : '400')
        .text(stage.label)

      if (stage.duration_us > 0) {
        const durMs = (stage.duration_us / 1000).toFixed(1)
        svg.append('text')
          .attr('x', x + nodeWidth / 2)
          .attr('y', centerY - 28)
          .attr('text-anchor', 'middle')
          .attr('fill', '#7d8590')
          .attr('font-size', '9px')
          .text(`${durMs}ms`)
      }
    })
  }, [displayStages, selectedStage, playing, currentStep])

  // Animation loop
  useEffect(() => {
    if (!playing) return
    const total = displayStages.length
    const interval = setTimeout(() => {
      setCurrentStep((prev) => {
        const next = (prev + 1) % (total + 1)
        if (next >= total) {
          setPlaying(false)
          return 0
        }
        return next
      })
    }, 2000 / speed)
    return () => clearTimeout(interval)
  }, [playing, currentStep, speed, displayStages.length])

  const runDemo = () => {
    setCurrentStep(0)
    setPlaying(true)

    const stages = [...displayStages]
    let time = 0
    for (let i = 0; i < stages.length; i++) {
      const dur = Math.random() * 5000 + 100
      stages[i] = {
        ...stages[i],
        status: i === 0 ? 'active' : 'pending',
        start_us: time,
        end_us: time + dur,
        duration_us: dur,
        details: {
          duration_us: Math.round(dur),
          ...(i === 6 ? { xlog_ptr: '0/16D4F30', rmgr_id: 2, rmgr_name: 'Heap' } : {}),
          ...(i === 8 ? { xid: 100 + i, state: 'committed' } : {}),
        }
      }
      time += dur + Math.random() * 200
    }
    setSelectedStage(null)
  }

  return (
    <div style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.25rem' }}>{config.title}</h2>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {/* View mode toggle */}
          <div style={{ display: 'flex', borderRadius: '4px', overflow: 'hidden', border: '1px solid var(--border)' }}>
            {(['nodes', 'gantt'] as const).map(mode => (
              <button key={mode} onClick={() => setViewMode(mode)}
                style={{
                  padding: '0.25rem 0.6rem',
                  background: viewMode === mode ? 'var(--accent)' : 'var(--bg-tertiary)',
                  color: viewMode === mode ? '#fff' : 'var(--text-muted)',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '0.75rem',
                }}>
                {mode === 'nodes' ? '节点' : 'Gantt'}
              </button>
            ))}
          </div>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>速度:</span>
          {[0.5, 1, 2].map((s) => (
            <button key={s} onClick={() => setSpeed(s)} style={{
              padding: '0.25rem 0.5rem',
              background: speed === s ? 'var(--accent)' : 'var(--bg-tertiary)',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '0.75rem',
            }}>
              {s}x
            </button>
          ))}
          <button onClick={runDemo} style={{
            padding: '0.5rem 1rem',
            background: 'var(--accent)',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '0.875rem',
          }}>
            {playing ? '运行中...' : '演示动画'}
          </button>
        </div>
      </div>

      {/* Pipeline SVG or Gantt */}
      {viewMode === 'nodes' ? (
        <div ref={containerRef} style={{
          background: 'var(--bg-secondary)',
          borderRadius: '8px',
          border: '1px solid var(--border)',
          padding: '1rem',
          marginBottom: selectedStage ? '1rem' : 0,
          overflow: 'hidden',
        }}>
          <svg ref={svgRef} style={{ width: '100%', display: 'block' }} />
        </div>
      ) : (
        <div style={{
          background: 'var(--bg-secondary)',
          borderRadius: '8px',
          border: '1px solid var(--border)',
          padding: '0.5rem',
          marginBottom: '1rem',
          overflowX: 'auto',
        }}>
          <PipelineGantt stages={displayStages} />
        </div>
      )}

      {/* Stage Legend */}
      <div style={{ display: 'flex', gap: '0.75rem', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#30363d', borderRadius: '50%', marginRight: 4 }} />未开始</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#58a6ff', borderRadius: '50%', marginRight: 4 }} />进行中</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#3fb950', borderRadius: '50%', marginRight: 4 }} />已完成</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#f85149', borderRadius: '50%', marginRight: 4 }} />错误</span>
      </div>

      {/* Detail Panel */}
      {selectedStage && (
        <div style={{
          padding: '1rem',
          background: 'var(--bg)',
          borderRadius: '8px',
          border: '1px solid var(--border)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <h3 style={{ fontSize: '1rem' }}>{selectedStage.name}</h3>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>{selectedStage.label}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.5rem', fontSize: '0.875rem' }}>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>状态: </span>
              <span style={{ color: selectedStage.status === 'done' ? 'var(--green)' : 'var(--accent)' }}>
                {selectedStage.status}
              </span>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>耗时: </span>
              <span>{selectedStage.duration_us > 0 ? `${(selectedStage.duration_us / 1000).toFixed(2)}ms` : '-'}</span>
            </div>
            {selectedStage.start_us > 0 && (
              <div>
                <span style={{ color: 'var(--text-muted)' }}>开始: </span>
                <span>{(selectedStage.start_us / 1000).toFixed(2)}ms</span>
              </div>
            )}
            {selectedStage.end_us > 0 && (
              <div>
                <span style={{ color: 'var(--text-muted)' }}>结束: </span>
                <span>{(selectedStage.end_us / 1000).toFixed(2)}ms</span>
              </div>
            )}
            {Object.entries(selectedStage.details).map(([key, val]) => (
              <div key={key} style={{ gridColumn: 'span 2' }}>
                <span style={{ color: 'var(--text-muted)' }}>{key}: </span>
                <span style={{ fontFamily: 'monospace' }}>{String(val)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
