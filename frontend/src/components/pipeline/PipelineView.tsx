import { useEffect, useMemo, useRef, useState } from 'react'
import * as d3 from 'd3'
import NodePageHeader from '../common/NodePageHeader'

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

const TITLES: Record<'write' | 'read' | 'transaction', string> = {
  write: '数据写入 Pipeline',
  read: '数据读取 Pipeline',
  transaction: '事务执行 Pipeline',
}

function PipelineGantt({ stages }: { stages: PipelineStage[] }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const doneStages = stages.filter((s) => s.duration_us > 0)
  const totalTime = doneStages.length > 0 ? Math.max(...doneStages.map((s) => s.end_us)) : 0

  useEffect(() => {
    if (!svgRef.current || !containerRef.current || doneStages.length === 0) return

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const width = containerRef.current.clientWidth
    const rowH = 28
    const labelW = 160
    const chartW = Math.max(240, width - labelW - 40)
    const marginTop = 10
    const marginBottom = 30

    const height = doneStages.length * rowH + marginTop + marginBottom
    svg.attr('width', width).attr('height', height)

    const xScale = d3.scaleLinear().domain([0, totalTime || 1]).range([0, chartW])
    const ticks = xScale.ticks(Math.min(8, Math.ceil(totalTime / 1000)))

    svg.append('g').selectAll('line').data(ticks).enter().append('line').attr('x1', (d) => labelW + xScale(d)).attr('y1', marginTop).attr('x2', (d) => labelW + xScale(d)).attr('y2', height - marginBottom).attr('stroke', '#21262d').attr('stroke-width', 1)
    svg.append('g').selectAll('text').data(ticks).enter().append('text').attr('x', (d) => labelW + xScale(d)).attr('y', height - 10).attr('text-anchor', 'middle').attr('fill', '#7d8590').attr('font-size', '9px').text((d) => (totalTime >= 1000 ? `${(d / 1000).toFixed(1)}ms` : `${d}us`))

    const barH = 18
    doneStages.forEach((stage, i) => {
      const y = marginTop + i * rowH
      const barX = labelW + xScale(stage.start_us)
      const barW = Math.max(2, xScale(stage.duration_us))
      const fillColor = stage.status === 'error' ? '#f85149' : stage.color || '#3fb950'

      svg.append('rect').attr('x', 0).attr('y', y).attr('width', width).attr('height', rowH).attr('fill', i % 2 === 0 ? 'transparent' : '#161b22')
      svg.append('text').attr('x', labelW - 8).attr('y', y + rowH / 2 + 1).attr('text-anchor', 'end').attr('dominant-baseline', 'middle').attr('fill', fillColor).attr('font-size', '10px').text(stage.label)
      svg.append('rect').attr('x', barX).attr('y', y + (rowH - barH) / 2).attr('width', barW).attr('height', barH).attr('fill', fillColor).attr('opacity', 0.88).attr('rx', 3)

      if (barW > 40) {
        svg.append('text').attr('x', barX + barW / 2).attr('y', y + rowH / 2 + 1).attr('text-anchor', 'middle').attr('dominant-baseline', 'middle').attr('fill', '#fff').attr('font-size', '9px').attr('font-weight', '600').text(stage.duration_us >= 1000 ? `${(stage.duration_us / 1000).toFixed(1)}ms` : `${stage.duration_us}us`)
      }
    })
  }, [doneStages, totalTime])

  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      <svg ref={svgRef} style={{ display: 'block', width: '100%' }} />
    </div>
  )
}

export default function PipelineView({ type = 'write', stages }: PipelineViewProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [selectedStage, setSelectedStage] = useState<PipelineStage | null>(null)
  const [viewMode, setViewMode] = useState<'nodes' | 'gantt'>('nodes')

  const displayStages = useMemo(() => stages ?? [], [stages])

  useEffect(() => {
    if (!svgRef.current || !containerRef.current || displayStages.length === 0) return

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const width = containerRef.current.clientWidth
    const height = 140
    const count = Math.max(displayStages.length, 1)
    const nodeWidth = Math.min(100, Math.max(60, (width - 140) / count))
    const centerY = 70

    svg.attr('width', width).attr('height', height)

    for (let i = 0; i < displayStages.length - 1; i++) {
      const x1 = 60 + i * nodeWidth + nodeWidth / 2
      const x2 = 60 + (i + 1) * nodeWidth + nodeWidth / 2
      svg.append('line').attr('x1', x1).attr('y1', centerY).attr('x2', x2).attr('y2', centerY).attr('stroke', '#30363d').attr('stroke-width', 2)
      svg.append('polygon').attr('points', `${x2},${centerY} ${x2 - 8},${centerY - 5} ${x2 - 8},${centerY + 5}`).attr('fill', '#30363d')
    }

    displayStages.forEach((stage, i) => {
      const x = 60 + i * nodeWidth
      const isSelected = selectedStage?.id === stage.id
      const fillColor = stage.status === 'error' ? '#f85149' : stage.status === 'done' ? stage.color || '#3fb950' : stage.status === 'active' ? '#58a6ff' : '#30363d'
      const strokeColor = isSelected ? '#58a6ff' : fillColor

      svg.append('circle').attr('cx', x + nodeWidth / 2).attr('cy', centerY).attr('r', 17).attr('fill', fillColor).attr('stroke', strokeColor).attr('stroke-width', isSelected ? 3 : 2).attr('cursor', 'pointer').on('click', () => setSelectedStage(isSelected ? null : stage))
      svg.append('text').attr('x', x + nodeWidth / 2).attr('y', centerY + 1).attr('text-anchor', 'middle').attr('dominant-baseline', 'middle').attr('fill', '#fff').attr('font-size', '11px').attr('font-weight', '700').text(i + 1)
      svg.append('text').attr('x', x + nodeWidth / 2).attr('y', centerY + 30).attr('text-anchor', 'middle').attr('fill', '#e6edf3').attr('font-size', '10px').text(stage.label)
    })
  }, [displayStages, selectedStage])

  const rightSlot = (
    <div style={{ display: 'flex', borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--border)' }}>
      {(['nodes', 'gantt'] as const).map((mode) => (
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
          {mode === 'nodes' ? '节点' : 'Gantt'}
        </button>
      ))}
    </div>
  )

  return (
    <div style={{ padding: '1.5rem' }}>
      <NodePageHeader
        title={TITLES[type]}
        source="collector 事件流 / useVisualizationData"
        updatedAtText={new Date().toLocaleTimeString('zh-CN', { hour12: false })}
        rightSlot={rightSlot}
      />

      {displayStages.length === 0 && (
        <div style={{ padding: '1rem', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>
          暂无真实 Pipeline 数据。请先触发对应链路并接入阶段事件。
        </div>
      )}

      {displayStages.length > 0 && viewMode === 'nodes' && (
        <div ref={containerRef} style={{ background: 'var(--bg-secondary)', borderRadius: '8px', border: '1px solid var(--border)', padding: '1rem', marginBottom: selectedStage ? '1rem' : 0, overflow: 'hidden' }}>
          <svg ref={svgRef} style={{ width: '100%', display: 'block' }} />
        </div>
      )}

      {displayStages.length > 0 && viewMode === 'gantt' && (
        <div style={{ background: 'var(--bg-secondary)', borderRadius: '8px', border: '1px solid var(--border)', padding: '0.5rem', marginBottom: '1rem', overflowX: 'auto' }}>
          <PipelineGantt stages={displayStages} />
        </div>
      )}

      {selectedStage && (
        <div style={{ padding: '1rem', background: 'var(--bg)', borderRadius: '8px', border: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <h3 style={{ fontSize: '1rem', margin: 0 }}>{selectedStage.name}</h3>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>{selectedStage.label}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.5rem', fontSize: '0.875rem' }}>
            <div><span style={{ color: 'var(--text-muted)' }}>状态: </span><span style={{ color: selectedStage.status === 'done' ? 'var(--green)' : 'var(--accent)' }}>{selectedStage.status}</span></div>
            <div><span style={{ color: 'var(--text-muted)' }}>耗时: </span><span>{selectedStage.duration_us > 0 ? `${(selectedStage.duration_us / 1000).toFixed(2)}ms` : '-'}</span></div>
            {selectedStage.start_us > 0 && <div><span style={{ color: 'var(--text-muted)' }}>开始: </span><span>{(selectedStage.start_us / 1000).toFixed(2)}ms</span></div>}
            {selectedStage.end_us > 0 && <div><span style={{ color: 'var(--text-muted)' }}>结束: </span><span>{(selectedStage.end_us / 1000).toFixed(2)}ms</span></div>}
            {Object.entries(selectedStage.details).map(([key, val]) => (
              <div key={key} style={{ gridColumn: 'span 2' }}><span style={{ color: 'var(--text-muted)' }}>{key}: </span><span style={{ fontFamily: 'monospace' }}>{String(val)}</span></div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
