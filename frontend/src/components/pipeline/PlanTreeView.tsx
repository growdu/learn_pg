import { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'
import NodePageHeader from '../common/NodePageHeader'

export interface PlanNode {
  id: string
  name: string
  label: string
  cost: number
  totalCost: number
  rows: number
  children?: PlanNode[]
}

interface PlanTreeViewProps {
  plan?: PlanNode
  onGoBack?: () => void
}

export default function PlanTreeView({ plan, onGoBack }: PlanTreeViewProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<PlanNode | null>(null)

  useEffect(() => {
    if (!svgRef.current || !containerRef.current || !plan) return

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const nodeWidth = 180
    const nodeHeight = 52
    const horizontalGap = 36
    const verticalGap = 32

    const root = d3.hierarchy(plan, (d) => d.children)
    const treeLayout = d3.tree<PlanNode>().nodeSize([nodeWidth + horizontalGap, nodeHeight + verticalGap]).separation((a, b) => (a.parent === b.parent ? 1 : 1.2))

    const treeData = treeLayout(root)
    const nodes = treeData.descendants()
    const links = treeData.links()

    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
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

    const maxCost = Math.max(plan.totalCost || 0, plan.cost || 0, 1)
    const colorScale = d3.scaleSequential().domain([0, maxCost]).interpolator(d3.interpolateBlues)

    g.selectAll('path').data(links).enter().append('path').attr('d', (d) => {
      const sx = d.source.x + nodeWidth / 2
      const sy = d.source.y + nodeHeight
      const tx = d.target.x + nodeWidth / 2
      const ty = d.target.y
      const midY = (sy + ty) / 2
      return `M ${sx},${sy} C ${sx},${midY} ${tx},${midY} ${tx},${ty}`
    }).attr('fill', 'none').attr('stroke', '#30363d').attr('stroke-width', 1.4)

    const nodeGroups = g.selectAll('g.node').data(nodes).enter().append('g').attr('class', 'node').attr('transform', (d) => `translate(${d.x}, ${d.y})`).attr('cursor', 'pointer').on('click', (_, d) => setSelected(d.data))

    nodeGroups.append('rect').attr('width', nodeWidth).attr('height', nodeHeight).attr('rx', 6).attr('fill', (d) => colorScale(d.data.cost)).attr('stroke', (d) => (selected?.id === d.data.id ? '#58a6ff' : '#30363d')).attr('stroke-width', (d) => (selected?.id === d.data.id ? 3 : 1))
    nodeGroups.append('text').attr('x', nodeWidth / 2).attr('y', 22).attr('text-anchor', 'middle').attr('fill', '#fff').attr('font-size', '10px').attr('font-weight', '600').text((d) => (d.data.name.length > 22 ? `${d.data.name.slice(0, 20)}..` : d.data.name))
    nodeGroups.append('text').attr('x', 8).attr('y', nodeHeight - 10).attr('fill', 'rgba(255,255,255,0.8)').attr('font-size', '9px').text((d) => `rows=${d.data.rows}`)
    nodeGroups.append('text').attr('x', nodeWidth - 8).attr('y', nodeHeight - 10).attr('text-anchor', 'end').attr('fill', 'rgba(255,255,255,0.8)').attr('font-size', '9px').text((d) => `cost=${d.data.cost.toFixed(1)}`)

    const zoom = d3.zoom<SVGSVGElement, unknown>().scaleExtent([0.2, 2]).on('zoom', (event) => {
      g.attr('transform', `translate(${-minX + 40 + event.transform.x}, ${-minY + 40 + event.transform.y}) scale(${event.transform.k})`)
    })

    svg.call(zoom)
  }, [plan, selected])

  return (
    <div style={{ padding: '1.5rem' }}>
      <NodePageHeader
        title="执行计划树"
        source="EXPLAIN (FORMAT JSON) 计划数据"
        updatedAtText={new Date().toLocaleTimeString('zh-CN', { hour12: false })}
        rightSlot={<div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>颜色深浅表示 cost，高亮节点可查看详情</div>}
        onBack={onGoBack}
      />

      {!plan && (
        <div style={{ padding: '1rem', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>
          暂无真实执行计划数据。请先执行带 `EXPLAIN (FORMAT JSON)` 的查询并接入计划结果。
        </div>
      )}

      {plan && (
        <div ref={containerRef} style={{ background: 'var(--bg-secondary)', borderRadius: '8px', border: '1px solid var(--border)', minHeight: '300px', overflow: 'auto' }}>
          <svg ref={svgRef} style={{ display: 'block' }} />
        </div>
      )}

      {selected && (
        <div style={{ marginTop: '1rem', padding: '1rem', background: 'var(--bg)', borderRadius: '8px', border: '1px solid var(--border)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', fontSize: '0.85rem' }}>
            <div><span style={{ color: 'var(--text-muted)' }}>节点:</span> {selected.name}</div>
            <div><span style={{ color: 'var(--text-muted)' }}>Cost:</span> {selected.cost.toFixed(2)}</div>
            <div><span style={{ color: 'var(--text-muted)' }}>Total Cost:</span> {selected.totalCost.toFixed(2)}</div>
            <div><span style={{ color: 'var(--text-muted)' }}>Rows:</span> {selected.rows}</div>
            <div style={{ gridColumn: 'span 2' }}><span style={{ color: 'var(--text-muted)' }}>Label:</span> <span style={{ fontFamily: 'monospace' }}>{selected.label}</span></div>
          </div>
        </div>
      )}
    </div>
  )
}
