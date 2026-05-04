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

// Stats computation
function computeStats(data: BufferCell[]) {
  const used = data.filter(b => b.hit_count > 0)
  const dirty = data.filter(b => b.is_dirty)
  const pinned = data.filter(b => b.is_pinned)
  const hits = used.map(b => b.hit_count)
  return {
    total: data.length,
    used: used.length,
    usedPct: data.length ? (used.length / data.length * 100).toFixed(1) : '0',
    dirty: dirty.length,
    dirtyPct: used.length ? (dirty.length / used.length * 100).toFixed(1) : '0',
    pinned: pinned.length,
    minHit: hits.length ? Math.min(...hits) : 0,
    maxHit: hits.length ? Math.max(...hits) : 0,
    avgHit: hits.length ? (hits.reduce((a, b) => a + b, 0) / hits.length).toFixed(1) : '0',
  }
}

// ─── Mini sparkline chart ─────────────────────────────────────────────────────

function HitCountSparkline({ data }: { data: BufferCell[] }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const W = 200; const H = 32

  useEffect(() => {
    if (!svgRef.current) return
    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const used = data.filter(b => b.hit_count > 0).sort((a, b) => a.buffer_id - b.buffer_id)
    if (used.length === 0) return

    const xScale = d3.scaleLinear().domain([0, used.length - 1]).range([0, W])
    const yScale = d3.scaleLinear().domain([0, Math.max(...used.map(b => b.hit_count))]).range([H - 2, 2])

    const area = d3.area<BufferCell>()
      .x((_, i) => xScale(i))
      .y0(H)
      .y1(d => yScale(d.hit_count))
      .curve(d3.curveMonotoneX)

    svg.append('path')
      .datum(used)
      .attr('d', area)
      .attr('fill', '#58a6ff')
      .attr('opacity', 0.3)

    const line = d3.line<BufferCell>()
      .x((_, i) => xScale(i))
      .y(d => yScale(d.hit_count))
      .curve(d3.curveMonotoneX)

    svg.append('path')
      .datum(used)
      .attr('d', line)
      .attr('fill', 'none')
      .attr('stroke', '#58a6ff')
      .attr('stroke-width', 1.5)
  }, [data])

  return <svg ref={svgRef} width={W} height={H} style={{ display: 'block' }} />
}

// ─── Dirty ratio bar ─────────────────────────────────────────────────────────

function DirtyRatioBar({ dirty, total }: { dirty: number; total: number }) {
  const pct = total ? dirty / total : 0
  return (
    <div style={{ marginTop: '0.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '3px' }}>
        <span>脏页比例</span>
        <span style={{ color: pct > 0.5 ? '#f85149' : '#7d8590' }}>{dirty}/{total} ({pct > 0 ? (pct * 100).toFixed(1) : '0'}%)</span>
      </div>
      <div style={{ background: '#21262d', borderRadius: '4px', height: '8px', overflow: 'hidden' }}>
        <div style={{
          width: `${pct * 100}%`,
          height: '100%',
          background: pct > 0.5 ? '#f85149' : pct > 0.2 ? '#d29922' : '#3fb950',
          borderRadius: '4px',
          transition: 'width 0.3s',
        }} />
      </div>
    </div>
  )
}

// ─── Time-series animation panel ────────────────────────────────────────────

function BufferTimelinePlayer({ data }: { data: BufferCell[] }) {
  const [frame, setFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [history, setHistory] = useState<BufferCell[][]>([])
  const FRAME_COUNT = 20

  // Build history on mount
  useEffect(() => {
    const frames: BufferCell[][] = [data]
    let current = data.map(b => ({ ...b, hit_count: 0, is_dirty: false, is_pinned: false }))
    for (let f = 1; f < FRAME_COUNT; f++) {
      // Simulate incremental buffer activity
      current = current.map(b => {
        const r = Math.random()
        const newHit = r > 0.6 ? Math.floor(Math.random() * 5) + 1 : 0
        return {
          ...b,
          hit_count: Math.min(100, b.hit_count + newHit),
          is_dirty: r > 0.85,
          is_pinned: r > 0.92,
        }
      })
      frames.push(current.map(b => ({ ...b })))
    }
    setHistory(frames)
  }, [data])

  useEffect(() => {
    if (!playing || history.length === 0) return
    const interval = setInterval(() => {
      setFrame(f => {
        if (f >= FRAME_COUNT - 1) {
          setPlaying(false)
          return 0
        }
        return f + 1
      })
    }, 300)
    return () => clearInterval(interval)
  }, [playing, history.length])

  const current = history[frame] || data
  const stats = computeStats(current)

  return (
    <div style={{
      marginTop: '1rem',
      padding: '0.75rem',
      background: 'var(--bg)',
      borderRadius: '8px',
      border: '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
        <span style={{ fontSize: '0.8rem', color: 'var(--accent)', fontWeight: 600 }}>Buffer 活动时序</span>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>帧 {frame + 1}/{FRAME_COUNT}</span>
          <button onClick={() => { setPlaying(!playing); if (frame >= FRAME_COUNT - 1) setFrame(0) }}
            style={{ padding: '2px 10px', background: playing ? 'var(--bg-tertiary)' : 'var(--accent)', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '0.7rem' }}>
            {playing ? '暂停' : '播放'}
          </button>
          <button onClick={() => { setFrame(0); setPlaying(false) }}
            style={{ padding: '2px 10px', background: 'var(--bg-tertiary)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '4px', cursor: 'pointer', fontSize: '0.7rem' }}>
            重置
          </button>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem', marginBottom: '0.5rem' }}>
        {[
          { label: '使用中', value: stats.used, color: '#58a6ff' },
          { label: '脏页', value: stats.dirty, color: '#f85149' },
          { label: 'Pinned', value: stats.pinned, color: '#d29922' },
          { label: '命中率↑', value: stats.avgHit, color: '#3fb950' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ textAlign: 'center', padding: '0.4rem', background: 'var(--bg-secondary)', borderRadius: '4px' }}>
            <div style={{ fontSize: '1rem', fontWeight: 700, color }}>{value}</div>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{label}</div>
          </div>
        ))}
      </div>
      <DirtyRatioBar dirty={stats.dirty} total={stats.used} />
    </div>
  )
}

// ─── Main heatmap ─────────────────────────────────────────────────────────────

export default function BufferHeatmapView({ buffers }: BufferHeatmapViewProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState<BufferCell | null>(null)
  const [showDirty, setShowDirty] = useState(true)
  const [showTimeline, setShowTimeline] = useState(false)
  const data = buffers || generateDemoBuffers()
  const colCount = 32
  const stats = computeStats(data)

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

    const maxHit = d3.max(data, (d) => d.hit_count) || 1
    const colorScale = d3.scaleSequential()
      .domain([0, maxHit])
      .interpolator(d3.interpolateBlues)

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

      if (cell.is_pinned) {
        g.append('circle')
          .attr('cx', x + cellSize - 4)
          .attr('cy', y + 4)
          .attr('r', 2)
          .attr('fill', '#58a6ff')
      }

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

    svg.append('text')
      .attr('x', 20)
      .attr('y', height - 4)
      .attr('fill', '#7d8590')
      .attr('font-size', '10px')
      .text(`Buffer Pool: ${data.length} buffers | 热度: 蓝(冷) → 白(热) | 红边框: 脏页 | 蓝点: pinned`)
  }, [data, colCount, showDirty])

  return (
    <div style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.25rem' }}>Buffer Pool 热图</h2>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
            <input type="checkbox" checked={showDirty} onChange={(e) => setShowDirty(e.target.checked)} style={{ cursor: 'pointer' }} />
            显示脏页
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
            <input type="checkbox" checked={showTimeline} onChange={(e) => setShowTimeline(e.target.checked)} style={{ cursor: 'pointer' }} />
            时序动画
          </label>
          <button onClick={() => setHovered(null)} style={{
            padding: '0.25rem 0.75rem', background: 'var(--bg-tertiary)', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: '4px', cursor: 'pointer', fontSize: '0.75rem',
          }}>
            刷新数据
          </button>
        </div>
      </div>

      {/* Statistics summary panel */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(5, 1fr)',
        gap: '0.75rem',
        marginBottom: '1rem',
      }}>
        {[
          { label: '总 Buffer', value: stats.total, color: '#7d8590' },
          { label: '使用中', value: `${stats.used} (${stats.usedPct}%)`, color: '#58a6ff' },
          { label: '脏页', value: `${stats.dirty} (${stats.dirtyPct}%)`, color: '#f85149' },
          { label: 'Pinned', value: stats.pinned, color: '#d29922' },
          { label: '平均命中', value: stats.avgHit, color: '#3fb950' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{
            padding: '0.6rem 0.75rem',
            background: 'var(--bg-secondary)',
            borderRadius: '6px',
            border: '1px solid var(--border)',
            textAlign: 'center',
          }}>
            <div style={{ fontSize: '1.1rem', fontWeight: 700, color }}>{value}</div>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '2px' }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Sparkline */}
      <div style={{ marginBottom: '0.75rem' }}>
        <HitCountSparkline data={data} />
      </div>

      <div ref={containerRef} style={{
        background: 'var(--bg-secondary)',
        borderRadius: '8px',
        border: '1px solid var(--border)',
        padding: '0.5rem',
        overflowX: 'auto',
      }}>
        <svg ref={svgRef} style={{ display: 'block' }} />
      </div>

      {/* Timeline player */}
      {showTimeline && <BufferTimelinePlayer data={data} />}

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
