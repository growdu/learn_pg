import { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'
import NodePageHeader from '../common/NodePageHeader'

export interface LockNode {
  id: string
  pid: number
  label: string
  type: 'backend' | 'lock'
}

export interface LockEdge {
  source: string
  target: string
  wait_time_us: number
  mode: string
}

interface LockGraphViewProps {
  nodes?: LockNode[]
  edges?: LockEdge[]
  onGoBack?: () => void
}

interface SimNode extends d3.SimulationNodeDatum, LockNode {}
interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  wait_time_us: number
  mode: string
}

function detectCycle(nodes: SimNode[], links: SimLink[]): string[][] {
  const adj: Map<string, string[]> = new Map()
  nodes.forEach((n) => adj.set(n.id, []))
  links.forEach((l) => {
    const src = typeof l.source === 'object' ? (l.source as SimNode).id : String(l.source)
    const tgt = typeof l.target === 'object' ? (l.target as SimNode).id : String(l.target)
    adj.get(src)?.push(tgt)
  })

  const cycles: string[][] = []
  const visited = new Set<string>()

  function dfs(node: string, path: string[]) {
    if (path.includes(node)) {
      const cycle = path.slice(path.indexOf(node))
      if (cycle.length >= 2) cycles.push(cycle)
      return
    }
    if (visited.has(node)) return
    visited.add(node)
    path.push(node)
    for (const next of adj.get(node) || []) dfs(next, [...path])
  }

  nodes.forEach((n) => {
    visited.clear()
    dfs(n.id, [])
  })

  return cycles
}

export default function LockGraphView({ nodes, edges, onGoBack }: LockGraphViewProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [selectedNode, setSelectedNode] = useState<LockNode | null>(null)
  const [cycles, setCycles] = useState<string[][]>([])
  const displayNodes = nodes ?? []
  const displayEdges = edges ?? []

  useEffect(() => {
    if (!svgRef.current || !containerRef.current) return

    const container = containerRef.current
    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const width = container.clientWidth
    const height = Math.max(400, container.clientHeight)
    svg.attr('width', width).attr('height', height)

    if (displayNodes.length === 0) {
      setCycles([])
      return
    }

    const simNodes: SimNode[] = displayNodes.map((n) => ({ ...n }))
    const simLinks: SimLink[] = displayEdges.map((e) => ({ source: e.source, target: e.target, wait_time_us: e.wait_time_us, mode: e.mode }))

    const detected = detectCycle(simNodes, simLinks)
    setCycles(detected)

    const simulation = d3
      .forceSimulation<SimNode>(simNodes)
      .force('link', d3.forceLink<SimNode, SimLink>(simLinks).id((d) => d.id).distance(100).strength(0.5))
      .force('charge', d3.forceManyBody().strength(-300))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(30))

    const linkGroup = svg.append('g')
    const linkElements = linkGroup
      .selectAll('line')
      .data(simLinks)
      .enter()
      .append('line')
      .attr('stroke', (d) => {
        const src = d.source as SimNode
        const tgt = d.target as SimNode
        return detected.some((c) => c.includes(src.id) && c.includes(tgt.id)) ? '#f85149' : '#7d8590'
      })
      .attr('stroke-width', (d) => Math.min(3, d.wait_time_us / 50000 + 1))
      .attr('stroke-dasharray', (d) => (d.mode === 'waiting' ? '5,3' : null))

    linkGroup
      .selectAll('text')
      .data(simLinks)
      .enter()
      .append('text')
      .attr('fill', '#7d8590')
      .attr('font-size', '9px')
      .attr('text-anchor', 'middle')
      .text((d) => d.mode)

    const nodeGroup = svg.append('g')
    const nodeElements = nodeGroup
      .selectAll('g')
      .data(simNodes)
      .enter()
      .append('g')
      .attr('cursor', 'pointer')
      .on('click', (_, d) => setSelectedNode(d as LockNode))

    const isInCycle = (id: string) => detected.some((c) => c.includes(id))

    nodeElements
      .append('circle')
      .attr('r', (d) => (d.type === 'lock' ? 24 : 20))
      .attr('fill', (d) => (d.type === 'lock' ? '#d29922' : '#58a6ff'))
      .attr('stroke', (d) => (isInCycle(d.id) ? '#f85149' : '#30363d'))
      .attr('stroke-width', (d) => (isInCycle(d.id) ? 3 : 1))

    nodeElements
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'middle')
      .attr('fill', 'white')
      .attr('font-size', '10px')
      .attr('font-weight', '600')
      .text((d) => (d.label.length > 10 ? `${d.label.slice(0, 8)}..` : d.label))

    nodeElements
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', '22px')
      .attr('fill', '#7d8590')
      .attr('font-size', '9px')
      .text((d) => (d.type === 'lock' ? 'LOCK' : `PID ${d.pid}`))

    const zoom = d3.zoom<SVGSVGElement, unknown>().scaleExtent([0.3, 3]).on('zoom', (event) => {
      svg.selectAll('g').attr('transform', event.transform)
    })
    svg.call(zoom)

    simulation.on('tick', () => {
      linkElements
        .attr('x1', (d: SimLink) => (d.source as SimNode).x ?? 0)
        .attr('y1', (d: SimLink) => (d.source as SimNode).y ?? 0)
        .attr('x2', (d: SimLink) => (d.target as SimNode).x ?? 0)
        .attr('y2', (d: SimLink) => (d.target as SimNode).y ?? 0)

      linkGroup
        .selectAll<SVGTextElement, SimLink>('text')
        .attr('x', (d: SimLink) => (((d.source as SimNode).x ?? 0) + ((d.target as SimNode).x ?? 0)) / 2)
        .attr('y', (d: SimLink) => (((d.source as SimNode).y ?? 0) + ((d.target as SimNode).y ?? 0)) / 2 - 5)

      nodeElements.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`)
    })

    return () => { simulation.stop() }
  }, [displayNodes, displayEdges])

  return (
    <div style={{ padding: '1.5rem' }}>
      <NodePageHeader
        title="锁等待图"
        source="/api/snapshot（backends + locks）"
        updatedAtText={new Date().toLocaleTimeString('zh-CN', { hour12: false })}
        rightSlot={
          cycles.length > 0 ? (
            <span style={{ padding: '0.25rem 0.75rem', background: '#f8514920', color: 'var(--red)', borderRadius: '12px', fontSize: '0.75rem', border: '1px solid var(--red)' }}>
              检测到 {cycles.length} 个死锁环
            </span>
          ) : null
        }
        onBack={onGoBack}
      />

      <div ref={containerRef} style={{ background: 'var(--bg-secondary)', borderRadius: '8px', border: '1px solid var(--border)', minHeight: '400px', overflow: 'hidden' }}>
        {displayNodes.length === 0 && <div style={{ padding: '1rem', color: 'var(--text-muted)', fontSize: '0.82rem' }}>暂无锁等待图数据，请先触发并发访问。</div>}
        <svg ref={svgRef} style={{ width: '100%', height: '400px', display: 'block' }} />
      </div>

      {selectedNode && (
        <div style={{ marginTop: '1rem', padding: '1rem', background: 'var(--bg)', borderRadius: '8px', border: '1px solid var(--border)' }}>
          <div style={{ fontSize: '0.92rem', marginBottom: '0.4rem', fontWeight: 600 }}>{selectedNode.label}</div>
          <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>类型：{selectedNode.type} | PID：{selectedNode.pid || '-'}</div>
        </div>
      )}
    </div>
  )
}
