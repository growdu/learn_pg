import { useEffect, useMemo, useRef, useState } from 'react'
import * as d3 from 'd3'
import NodePageHeader from '../common/NodePageHeader'

export interface BufferCell {
  buffer_id: number
  hit_count: number
  is_dirty: boolean
  is_pinned: boolean
  relfilenode: number
}

interface BufferHeatmapViewProps {
  buffers?: BufferCell[]
  onGoBack?: () => void
}

function computeStats(data: BufferCell[]) {
  const used = data.filter((b) => b.hit_count > 0)
  const dirty = data.filter((b) => b.is_dirty)
  const pinned = data.filter((b) => b.is_pinned)
  const hits = used.map((b) => b.hit_count)
  return {
    total: data.length,
    used: used.length,
    usedPct: data.length ? (used.length / data.length) * 100 : 0,
    dirty: dirty.length,
    dirtyPct: used.length ? (dirty.length / used.length) * 100 : 0,
    pinned: pinned.length,
    avgHit: hits.length ? hits.reduce((a, b) => a + b, 0) / hits.length : 0,
  }
}

function HitCountSparkline({ data }: { data: BufferCell[] }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const W = 220
  const H = 36

  useEffect(() => {
    if (!svgRef.current) return
    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()
    const used = data.filter((b) => b.hit_count > 0).sort((a, b) => a.buffer_id - b.buffer_id)
    if (used.length === 0) return

    const xScale = d3.scaleLinear().domain([0, used.length - 1]).range([0, W])
    const yScale = d3.scaleLinear().domain([0, Math.max(...used.map((b) => b.hit_count))]).range([H - 2, 2])

    const area = d3.area<BufferCell>().x((_, i) => xScale(i)).y0(H).y1((d) => yScale(d.hit_count)).curve(d3.curveMonotoneX)
    svg.append('path').datum(used).attr('d', area).attr('fill', '#58a6ff').attr('opacity', 0.25)

    const line = d3.line<BufferCell>().x((_, i) => xScale(i)).y((d) => yScale(d.hit_count)).curve(d3.curveMonotoneX)
    svg.append('path').datum(used).attr('d', line).attr('fill', 'none').attr('stroke', '#58a6ff').attr('stroke-width', 1.5)
  }, [data])

  return <svg ref={svgRef} width={W} height={H} style={{ display: 'block' }} />
}

export default function BufferHeatmapView({ buffers, onGoBack }: BufferHeatmapViewProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState<BufferCell | null>(null)
  const [showDirty, setShowDirty] = useState(true)

  const data = useMemo(() => buffers ?? [], [buffers])
  const stats = useMemo(() => computeStats(data), [data])
  const colCount = 32

  useEffect(() => {
    if (!svgRef.current || !containerRef.current || data.length === 0) return
    const container = containerRef.current
    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const width = container.clientWidth
    const cellSize = Math.max(6, Math.floor((width - 40) / colCount))
    const rows = Math.ceil(data.length / colCount)
    const height = rows * (cellSize + 2) + 20

    svg.attr('width', width).attr('height', height)
    const maxHit = d3.max(data, (d) => d.hit_count) || 1
    const colorScale = d3.scaleSequential().domain([0, maxHit]).interpolator(d3.interpolateBlues)

    data.forEach((cell, i) => {
      const col = i % colCount
      const row = Math.floor(i / colCount)
      const x = 20 + col * cellSize
      const y = 10 + row * (cellSize + 2)
      const fillColor = cell.hit_count === 0 ? '#21262d' : cell.is_dirty && showDirty ? d3.interpolateOranges(Math.min(cell.hit_count / maxHit, 1)) : colorScale(cell.hit_count)

      const g = svg.append('g').attr('cursor', 'pointer').on('mouseover', () => setHovered(cell)).on('mouseout', () => setHovered(null))
      g.append('rect').attr('x', x).attr('y', y).attr('width', cellSize - 1).attr('height', cellSize - 1).attr('fill', fillColor).attr('rx', 2)
      if (cell.is_dirty) g.append('rect').attr('x', x).attr('y', y).attr('width', cellSize - 1).attr('height', cellSize - 1).attr('fill', 'none').attr('stroke', '#f85149').attr('stroke-width', cellSize > 12 ? 2 : 1).attr('rx', 2)
      if (cell.is_pinned) g.append('circle').attr('cx', x + cellSize - 4).attr('cy', y + 4).attr('r', 2).attr('fill', '#58a6ff')
    })

    svg.append('text').attr('x', 20).attr('y', height - 4).attr('fill', '#7d8590').attr('font-size', '10px').text(`Buffer 总数 ${data.length} | 红框=脏页 | 蓝点=pinned`)
  }, [data, showDirty])

  const headerRight = (
    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
      <input type="checkbox" checked={showDirty} onChange={(e) => setShowDirty(e.target.checked)} style={{ cursor: 'pointer' }} />
      高亮脏页
    </label>
  )

  if (data.length === 0) {
    return (
      <div style={{ padding: '1.5rem' }}>
        <NodePageHeader title="Buffer Pool 热图" source="buffer_pin 事件流" updatedAtText={new Date().toLocaleTimeString('zh-CN', { hour12: false })} rightSlot={headerRight} onBack={onGoBack} />
        <div style={{ padding: '1rem', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>
          暂无真实 Buffer 数据。请先激活节点并产生 `buffer_pin` / 相关采样数据。
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: '1.5rem' }}>
      <NodePageHeader title="Buffer Pool 热图" source="buffer_pin 事件流" updatedAtText={new Date().toLocaleTimeString('zh-CN', { hour12: false })} rightSlot={headerRight} onBack={onGoBack} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '0.75rem', marginBottom: '1rem' }}>
        {[
          { label: '总 Buffer', value: stats.total, color: '#7d8590' },
          { label: '使用中', value: `${stats.used} (${stats.usedPct.toFixed(1)}%)`, color: '#58a6ff' },
          { label: '脏页', value: `${stats.dirty} (${stats.dirtyPct.toFixed(1)}%)`, color: '#f85149' },
          { label: 'Pinned', value: stats.pinned, color: '#d29922' },
          { label: '平均命中', value: stats.avgHit.toFixed(1), color: '#3fb950' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ padding: '0.6rem 0.75rem', background: 'var(--bg-secondary)', borderRadius: '6px', border: '1px solid var(--border)', textAlign: 'center' }}>
            <div style={{ fontSize: '1.1rem', fontWeight: 700, color }}>{value}</div>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '2px' }}>{label}</div>
          </div>
        ))}
      </div>

      <div style={{ marginBottom: '0.75rem' }}><HitCountSparkline data={data} /></div>

      <div ref={containerRef} style={{ background: 'var(--bg-secondary)', borderRadius: '8px', border: '1px solid var(--border)', padding: '0.5rem', overflowX: 'auto' }}>
        <svg ref={svgRef} style={{ display: 'block' }} />
      </div>

      {hovered && (
        <div style={{ marginTop: '1rem', padding: '1rem', background: 'var(--bg)', borderRadius: '8px', border: '1px solid var(--border)', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', fontSize: '0.875rem' }}>
          <div><span style={{ color: 'var(--text-muted)' }}>Buffer ID: </span><span style={{ fontFamily: 'monospace', color: 'var(--accent)' }}>{hovered.buffer_id}</span></div>
          <div><span style={{ color: 'var(--text-muted)' }}>命中次数: </span><span>{hovered.hit_count}</span></div>
          <div><span style={{ color: 'var(--text-muted)' }}>RelFileNode: </span><span style={{ fontFamily: 'monospace' }}>{hovered.relfilenode || '-'}</span></div>
          <div><span style={{ color: 'var(--text-muted)' }}>脏页: </span><span style={{ color: hovered.is_dirty ? 'var(--red)' : 'var(--green)' }}>{hovered.is_dirty ? '是' : '否'}</span></div>
          <div><span style={{ color: 'var(--text-muted)' }}>Pinned: </span><span style={{ color: hovered.is_pinned ? 'var(--yellow)' : 'var(--green)' }}>{hovered.is_pinned ? '是' : '否'}</span></div>
          <div><span style={{ color: 'var(--text-muted)' }}>行列: </span><span style={{ fontFamily: 'monospace' }}>{Math.floor(hovered.buffer_id / colCount)},{hovered.buffer_id % colCount}</span></div>
        </div>
      )}
    </div>
  )
}
