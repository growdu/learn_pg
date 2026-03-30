import { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'

export interface BufferCell {
  buffer_id: number
  hit_count: number
  is_dirty: boolean
  is_pinned: boolean
  relfilenode: number
}

interface BufferHeatmapViewProps {
  buffers?: BufferCell[]
}

// Generate demo data for 512 buffers
function generateDemoBuffers(count = 512): BufferCell[] {
  const buffers: BufferCell[] = []
  for (let i = 0; i < count; i++) {
    const isUsed = Math.random() > 0.3
    buffers.push({
      buffer_id: i,
      hit_count: isUsed ? Math.floor(Math.random() * 100) : 0,
      is_dirty: isUsed && Math.random() > 0.7,
      is_pinned: isUsed && Math.random() > 0.9,
      relfilenode: isUsed ? Math.floor(Math.random() * 10000) + 1 : 0,
    })
  }
  return buffers
}

export default function BufferHeatmapView({ buffers }: BufferHeatmapViewProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState<BufferCell | null>(null)
  const [showDirty, setShowDirty] = useState(true)
  const data = buffers || generateDemoBuffers()
  const colCount = 32

  useEffect(() => {
    if (!svgRef.current || !containerRef.current) return

    const container = containerRef.current
    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const width = container.clientWidth
    const cellSize = Math.floor((width - 40) / colCount)
    const rows = Math.ceil(data.length / colCount)
    const height = rows * (cellSize + 2) + 20

    svg.attr('width', width).attr('height', height)

    // Color scale: gray (unused) -> blue -> green -> yellow -> orange -> red
    const maxHit = d3.max(data, (d) => d.hit_count) || 1
    const colorScale = d3.scaleSequential()
      .domain([0, maxHit])
      .interpolator(d3.interpolateBlues)

    // Draw cells
    data.forEach((cell, i) => {
      const col = i % colCount
      const row = Math.floor(i / colCount)
      const x = 20 + col * cellSize
      const y = 10 + row * (cellSize + 2)

      const fillColor = cell.hit_count === 0 ? '#21262d'
        : cell.is_dirty && showDirty
          ? d3.interpolateOranges(Math.min(cell.hit_count / maxHit, 1))
          : colorScale(cell.hit_count)

      const g = svg.append('g')
        .attr('cursor', 'pointer')
        .on('mouseover', () => setHovered(cell))
        .on('mouseout', () => setHovered(null))

      g.append('rect')
        .attr('x', x)
        .attr('y', y)
        .attr('width', cellSize - 1)
        .attr('height', cellSize - 1)
        .attr('fill', fillColor)
        .attr('rx', 2)

      // Dirty indicator: red border
      if (cell.is_dirty) {
        g.append('rect')
          .attr('x', x)
          .attr('y', y)
          .attr('width', cellSize - 1)
          .attr('height', cellSize - 1)
          .attr('fill', 'none')
          .attr('stroke', '#f85149')
          .attr('stroke-width', cellSize > 12 ? 2 : 1)
          .attr('rx', 2)
      }

      // Pinned indicator: small dot
      if (cell.is_pinned) {
        g.append('circle')
          .attr('cx', x + cellSize - 4)
          .attr('cy', y + 4)
          .attr('r', 2)
          .attr('fill', '#58a6ff')
      }

      // Hit count text (only if cell is large enough)
      if (cellSize >= 14 && cell.hit_count > 0) {
        g.append('text')
          .attr('x', x + cellSize / 2)
          .attr('y', y + cellSize / 2 + 1)
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'middle')
          .attr('fill', cell.hit_count > maxHit * 0.6 ? 'white' : '#e6edf3')
          .attr('font-size', cellSize >= 20 ? '10px' : '8px')
          .text(cell.hit_count > 99 ? '99+' : cell.hit_count)
      }
    })

    // Legend title
    svg.append('text')
      .attr('x', 20)
      .attr('y', height - 4)
      .attr('fill', '#7d8590')
      .attr('font-size', '10px')
      .text(`Buffer Pool: ${data.length} buffers | 热度: 蓝(冷) → 白(热) | 红边框: 脏页 | 蓝点: pinned`)
  }, [data, colCount, showDirty, hovered])

  return (
    <div style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.25rem' }}>Buffer Pool 热图</h2>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
            <input
              type="checkbox"
              checked={showDirty}
              onChange={(e) => setShowDirty(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            显示脏页
          </label>
          <button
            onClick={() => {
              setHovered(null)
            }}
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
            刷新数据
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        style={{
          background: 'var(--bg-secondary)',
          borderRadius: '8px',
          border: '1px solid var(--border)',
          padding: '0.5rem',
          overflowX: 'auto',
        }}
      >
        <svg ref={svgRef} style={{ display: 'block' }} />
      </div>

      {/* Hover Detail */}
      {hovered && (
        <div style={{
          marginTop: '1rem',
          padding: '1rem',
          background: 'var(--bg)',
          borderRadius: '8px',
          border: '1px solid var(--border)',
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '0.5rem',
          fontSize: '0.875rem',
        }}>
          <div>
            <span style={{ color: 'var(--text-muted)' }}>Buffer ID: </span>
            <span style={{ fontFamily: 'monospace', color: 'var(--accent)' }}>{hovered.buffer_id}</span>
          </div>
          <div>
            <span style={{ color: 'var(--text-muted)' }}>访问次数: </span>
            <span>{hovered.hit_count}</span>
          </div>
          <div>
            <span style={{ color: 'var(--text-muted)' }}>RelFileNode: </span>
            <span style={{ fontFamily: 'monospace' }}>{hovered.relfilenode}</span>
          </div>
          <div>
            <span style={{ color: 'var(--text-muted)' }}>脏页: </span>
            <span style={{ color: hovered.is_dirty ? 'var(--red)' : 'var(--green)' }}>
              {hovered.is_dirty ? '是' : '否'}
            </span>
          </div>
          <div>
            <span style={{ color: 'var(--text-muted)' }}>Pinned: </span>
            <span style={{ color: hovered.is_pinned ? 'var(--yellow)' : 'var(--green)' }}>
              {hovered.is_pinned ? '是' : '否'}
            </span>
          </div>
          <div>
            <span style={{ color: 'var(--text-muted)' }}>行号: </span>
            <span style={{ fontFamily: 'monospace' }}>
              {Math.floor(hovered.buffer_id / colCount)},{(hovered.buffer_id % colCount)}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}