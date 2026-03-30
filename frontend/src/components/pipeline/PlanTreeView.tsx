import { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'

export interface PlanNode {
  id: string
  name: string
  label: string
  cost: number
  totalCost: number
  rows: number
  children?: PlanNode[]
}

// Demo execution plan for SELECT * FROM users WHERE id > 10
const DEMO_PLAN: PlanNode = {
  id: 'root',
  name: 'Seq Scan on users',
  label: 'Seq Scan on users',
  cost: 0,
  totalCost: 35.5,
  rows: 100,
  children: [
    {
      id: 'filter',
      name: 'Filter',
      label: 'Filter: (id > 10)',
      cost: 5.0,
      totalCost: 35.5,
      rows: 90,
      children: [
        {
          id: 'index',
          name: 'Index Scan using idx_users_id',
          label: 'Index Scan using idx_users_id',
          cost: 25.0,
          totalCost: 30.5,
          rows: 90,
        },
      ],
    },
    {
      id: 'sort',
      name: 'Sort',
      label: 'Sort Key: name',
      cost: 2.0,
      totalCost: 5.0,
      rows: 90,
      children: [
        {
          id: 'materialize',
          name: 'Materialize',
          label: 'Materialize',
          cost: 1.0,
          totalCost: 3.0,
          rows: 90,
          children: [
            {
              id: 'cte',
              name: 'CTE Scan on recent_users',
              label: 'CTE Scan on recent_users',
              cost: 0.5,
              totalCost: 2.0,
              rows: 50,
            },
          ],
        },
      ],
    },
  ],
}

interface PlanTreeViewProps {
  plan?: PlanNode
}

export default function PlanTreeView({ plan }: PlanTreeViewProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<PlanNode | null>(null)
  const displayPlan = plan || DEMO_PLAN

  useEffect(() => {
    if (!svgRef.current || !containerRef.current || !displayPlan) return

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const nodeWidth = 180
    const nodeHeight = 50
    const horizontalGap = 40
    const verticalGap = 30

    // Build hierarchy
    const root = d3.hierarchy(displayPlan, (d) => d.children)
    const treeLayout = d3.tree<PlanNode>()
      .nodeSize([nodeWidth + horizontalGap, nodeHeight + verticalGap])
      .separation((a, b) => (a.parent === b.parent ? 1 : 1.2))

    const treeData = treeLayout(root)
    const nodes = treeData.descendants()
    const links = treeData.links()

    // Calculate bounds
    let minX = Infinity, maxX = -Infinity
    let minY = Infinity, maxY = -Infinity
    nodes.forEach((n) => {
      if (n.x < minX) minX = n.x
      if (n.x > maxX) maxX = n.x
      if (n.y < minY) minY = n.y
      if (n.y > maxY) maxY = n.y
    })

    const width = maxX - minX + nodeWidth + 80
    const height = maxY - minY + nodeHeight + 80

    svg.attr('width', width).attr('height', height)

    const g = svg.append('g').attr('transform', `translate(${-minX + 40}, ${-minY + 40})`)

    // Color scale by cost
    const maxCost = displayPlan.totalCost || 1
    const colorScale = d3.scaleSequential()
      .domain([0, maxCost])
      .interpolator(d3.interpolateBlues)

    // Draw links
    g.selectAll('path')
      .data(links)
      .enter()
      .append('path')
      .attr('d', (d) => {
        const sx = d.source.x + nodeWidth / 2
        const sy = d.source.y + nodeHeight
        const tx = d.target.x + nodeWidth / 2
        const ty = d.target.y
        const midY = (sy + ty) / 2
        return `M ${sx},${sy} C ${sx},${midY} ${tx},${midY} ${tx},${ty}`
      })
      .attr('fill', 'none')
      .attr('stroke', '#30363d')
      .attr('stroke-width', 1.5)

    // Draw nodes
    const nodeGroups = g.selectAll('g')
      .data(nodes)
      .enter()
      .append('g')
      .attr('transform', (d) => `translate(${d.x}, ${d.y})`)
      .attr('cursor', 'pointer')
      .on('click', (_, d) => setSelected(d.data))

    // Node background
    nodeGroups.append('rect')
      .attr('width', nodeWidth)
      .attr('height', nodeHeight)
      .attr('rx', 6)
      .attr('fill', (d) => colorScale(d.data.cost))
      .attr('stroke', (d) => selected?.id === d.data.id ? '#58a6ff' : '#30363d')
      .attr('stroke-width', (d) => selected?.id === d.data.id ? 3 : 1)

    // Cost badge
    nodeGroups.append('rect')
      .attr('x', nodeWidth - 30)
      .attr('y', 4)
      .attr('width', 26)
      .attr('height', 16)
      .attr('rx', 3)
      .attr('fill', '#21262d')
      .attr('opacity', 0.9)

    nodeGroups.append('text')
      .attr('x', nodeWidth - 17)
      .attr('y', 15)
      .attr('text-anchor', 'middle')
      .attr('fill', '#e6edf3')
      .attr('font-size', '9px')
      .attr('font-weight', '600')
      .text((d) => d.data.cost.toFixed(0))

    // Node label (split if long)
    nodeGroups.append('text')
      .attr('x', nodeWidth / 2)
      .attr('y', 24)
      .attr('text-anchor', 'middle')
      .attr('fill', 'white')
      .attr('font-size', '10px')
      .attr('font-weight', '500')
      .text((d) => d.data.name.length > 22 ? d.data.name.substring(0, 20) + '..' : d.data.name)

    // Row count
    nodeGroups.append('text')
      .attr('x', 8)
      .attr('y', nodeHeight - 8)
      .attr('fill', 'rgba(255,255,255,0.7)')
      .attr('font-size', '9px')
      .text((d) => `rows=${d.data.rows}`)

    // Zoom
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 2])
      .on('zoom', (event) => {
        g.attr('transform', `translate(${-minX + 40 + event.transform.x}, ${-minY + 40 + event.transform.y}) scale(${event.transform.k})`)
      })

    svg.call(zoom)
  }, [displayPlan, selected])

  return (
    <div style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.25rem' }}>执行计划树</h2>
        <div style={{ display: 'flex', gap: '0.5rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          <span>🖱️ 点击节点查看详情 滚轮缩放</span>
          <span>🟦 颜色深度 = 估算 cost</span>
        </div>
      </div>

      <div
        ref={containerRef}
        style={{
          background: 'var(--bg-secondary)',
          borderRadius: '8px',
          border: '1px solid var(--border)',
          minHeight: '300px',
          overflow: 'auto',
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
        <span>颜色越深 → cost 越高</span>
        <span>| 数字标签 = 该节点 cost</span>
        <span>| rows = 估算返回行数</span>
      </div>

      {/* Detail Panel */}
      {selected && (
        <div style={{
          marginTop: '1rem',
          padding: '1rem',
          background: 'var(--bg)',
          borderRadius: '8px',
          border: '1px solid var(--border)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <h3 style={{ fontSize: '1rem' }}>{selected.name}</h3>
            <button
              onClick={() => setSelected(null)}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
            >
              ✕
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', fontSize: '0.875rem' }}>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Node Cost: </span>
              <span style={{ fontFamily: 'monospace' }}>{selected.cost.toFixed(2)}</span>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Total Cost: </span>
              <span style={{ fontFamily: 'monospace' }}>{selected.totalCost.toFixed(2)}</span>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Est. Rows: </span>
              <span style={{ fontFamily: 'monospace' }}>{selected.rows}</span>
            </div>
            <div style={{ gridColumn: 'span 3' }}>
              <span style={{ color: 'var(--text-muted)' }}>Full Label: </span>
              <span style={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>{selected.label}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}