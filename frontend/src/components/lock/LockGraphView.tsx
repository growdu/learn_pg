import { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'

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
}

interface SimNode extends d3.SimulationNodeDatum, LockNode {}
interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  wait_time_us: number
  mode: string
}

// Demo data: processes waiting for locks
function generateDemoData(): { nodes: LockNode[]; edges: LockEdge[] } {
  const nodes: LockNode[] = [
    { id: 'pid-1001', pid: 1001, label: 'PID 1001', type: 'backend' },
    { id: 'pid-1002', pid: 1002, label: 'PID 1002', type: 'backend' },
    { id: 'pid-1003', pid: 1003, label: 'PID 1003', type: 'backend' },
    { id: 'pid-1004', pid: 1004, label: 'PID 1004', type: 'backend' },
    { id: 'lock-table', pid: 0, label: 'table:users', type: 'lock' },
    { id: 'lock-row', pid: 0, label: 'row:accounts:42', type: 'lock' },
    { id: 'lock-index', pid: 0, label: 'index:idx_id', type: 'lock' },
  ]
  const edges: LockEdge[] = [
    { source: 'pid-1001', target: 'lock-table', wait_time_us: 0, mode: 'ShareLock' },
    { source: 'pid-1002', target: 'lock-table', wait_time_us: 50000, mode: 'ExclusiveLock' },
    { source: 'pid-1003', target: 'lock-row', wait_time_us: 120000, mode: 'ShareUpdateExclusiveLock' },
    { source: 'pid-1004', target: 'lock-index', wait_time_us: 30000, mode: 'ShareLock' },
    { source: 'pid-1003', target: 'pid-1002', wait_time_us: 80000, mode: 'waiting' },
  ]
  return { nodes, edges }
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
  const stack: string[][] = []

  function dfs(node: string, path: string[]) {
    if (stack.some((p) => p.includes(node))) {
      const startIdx = stack.find((p) => p.includes(node))
      if (startIdx !== undefined) {
        const cycle = path.slice(path.indexOf(node))
        if (cycle.length >= 2) cycles.push(cycle)
      }
      return
    }
    if (visited.has(node)) return

    visited.add(node)
    path.push(node)

    for (const next of adj.get(node) || []) {
      dfs(next, [...path])
    }
  }

  nodes.forEach((n) => {
    visited.clear()
    dfs(n.id, [])
  })

  return cycles
}

export default function LockGraphView({ nodes, edges }: LockGraphViewProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [selectedNode, setSelectedNode] = useState<LockNode | null>(null)
  const [cycles, setCycles] = useState<string[][]>([])
  const demoData = generateDemoData()
  const displayNodes = nodes || demoData.nodes
  const displayEdges = edges || demoData.edges

  useEffect(() => {
    if (!svgRef.current || !containerRef.current) return

    const container = containerRef.current
    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const width = container.clientWidth
    const height = Math.max(400, container.clientHeight)

    svg.attr('width', width).attr('height', height)

    const simNodes: SimNode[] = displayNodes.map((n) => ({ ...n }))
    const simLinks: SimLink[] = displayEdges.map((e) => ({
      source: e.source,
      target: e.target,
      wait_time_us: e.wait_time_us,
      mode: e.mode,
    }))

    // Detect cycles
    const detected = detectCycle(simNodes as SimNode[], simLinks as SimLink[])
    setCycles(detected)

    // Build simulation
    const simulation = d3.forceSimulation<SimNode>(simNodes)
      .force('link', d3.forceLink<SimNode, SimLink>(simLinks).id((d) => d.id).distance(100).strength(0.5))
      .force('charge', d3.forceManyBody().strength(-300))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(30))

    // Draw links
    const linkGroup = svg.append('g')
    const linkElements = linkGroup.selectAll('line')
      .data(simLinks)
      .enter()
      .append('line')
      .attr('stroke', (d) => {
        const src = d.source as SimNode
        const tgt = d.target as SimNode
        return cycles.some((c) => c.includes(src.id) && c.includes(tgt.id)) ? '#f85149' : '#7d8590'
      })
      .attr('stroke-width', (d) => Math.min(3, d.wait_time_us / 50000 + 1))
      .attr('stroke-dasharray', (d) => d.mode === 'waiting' ? '5,3' : null)

    // Draw link labels
    linkGroup.selectAll('text')
      .data(simLinks)
      .enter()
      .append('text')
      .attr('fill', '#7d8590')
      .attr('font-size', '9px')
      .attr('text-anchor', 'middle')
      .text((d) => d.mode)

    // Draw nodes
    const nodeGroup = svg.append('g')
    const nodeElements = nodeGroup.selectAll('g')
      .data(simNodes)
      .enter()
      .append('g')
      .attr('cursor', 'pointer')
      .on('click', (_, d) => setSelectedNode(d as LockNode))

    // Node circles
    nodeElements.append('circle')
      .attr('r', (d) => d.type === 'lock' ? 24 : 20)
      .attr('fill', (d) => d.type === 'lock' ? '#d29922' : '#58a6ff')
      .attr('stroke', (d) => {
        const isInCycle = cycles.some((c) => c.includes(d.id))
        return isInCycle ? '#f85149' : '#30363d'
      })
      .attr('stroke-width', (d) => cycles.some((c) => c.includes(d.id)) ? 3 : 1)

    // Node labels
    nodeElements.append('text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'middle')
      .attr('fill', 'white')
      .attr('font-size', '10px')
      .attr('font-weight', '600')
      .text((d) => d.label.length > 10 ? d.label.substring(0, 8) + '..' : d.label)

    // Node sub-labels
    nodeElements.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', '22px')
      .attr('fill', '#7d8590')
      .attr('font-size', '9px')
      .text((d) => d.type === 'lock' ? '🔒' : `PID ${d.pid}`)

    // Drag behavior
    const drag = d3.drag<SVGGElement, SimNode>()
      .on('start', (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart()
        d.fx = d.x
        d.fy = d.y
      })
      .on('drag', (event, d) => {
        d.fx = event.x
        d.fy = event.y
      })
      .on('end', (event, d) => {
        if (!event.active) simulation.alphaTarget(0)
        d.fx = null
        d.fy = null
      })

    nodeElements.call(drag)

    // Zoom
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 3])
      .on('zoom', (event) => {
        svg.selectAll('g').attr('transform', event.transform)
      })

    svg.call(zoom)

    // Update positions on tick
    simulation.on('tick', () => {
      linkElements
        .attr('x1', (d: SimLink) => (d.source as SimNode).x ?? 0)
        .attr('y1', (d: SimLink) => (d.source as SimNode).y ?? 0)
        .attr('x2', (d: SimLink) => (d.target as SimNode).x ?? 0)
        .attr('y2', (d: SimLink) => (d.target as SimNode).y ?? 0)

      linkGroup.selectAll<SVGTextElement, SimLink>('text')
        .attr('x', (d: SimLink) => (((d.source as SimNode).x ?? 0) + ((d.target as SimNode).x ?? 0)) / 2)
        .attr('y', (d: SimLink) => (((d.source as SimNode).y ?? 0) + ((d.target as SimNode).y ?? 0)) / 2 - 5)

      nodeElements.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`)
    })

    return () => { simulation.stop() }
  }, [displayNodes, displayEdges, cycles])

  return (
    <div style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <h2 style={{ fontSize: '1.25rem' }}>锁等待图</h2>
          {cycles.length > 0 && (
            <span style={{
              padding: '0.25rem 0.75rem',
              background: '#f8514920',
              color: 'var(--red)',
              borderRadius: '12px',
              fontSize: '0.75rem',
              border: '1px solid var(--red)',
            }}>
              ⚠️ 检测到 {cycles.length} 个死锁环
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          <span>🖱️ 拖拽节点 滚轮缩放</span>
          <span style={{ color: 'var(--border)' }}>|</span>
          <span>🔵 PID 进程  🟡 🔒 锁对象  🔴 死锁</span>
        </div>
      </div>

      <div
        ref={containerRef}
        style={{
          background: 'var(--bg-secondary)',
          borderRadius: '8px',
          border: '1px solid var(--border)',
          minHeight: '400px',
          overflow: 'hidden',
        }}
      >
        <svg ref={svgRef} style={{ width: '100%', height: '400px', display: 'block' }} />
      </div>

      {/* Deadlock detail */}
      {cycles.length > 0 && (
        <div style={{
          marginTop: '1rem',
          padding: '1rem',
          background: '#f8514910',
          borderRadius: '8px',
          border: '1px solid var(--red)',
        }}>
          <div style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--red)', marginBottom: '0.5rem' }}>
            死锁详情
          </div>
          {cycles.map((cycle, i) => (
            <div key={i} style={{ fontSize: '0.875rem', marginBottom: '0.25rem' }}>
              {cycle.map((id, j) => {
                const node = displayNodes.find((n) => n.id === id)
                return (
                  <span key={j}>
                    <span style={{ color: 'var(--accent)' }}>{node?.label || id}</span>
                    {j < cycle.length - 1 && <span style={{ color: 'var(--red)' }}> → </span>}
                  </span>
                )
              })}
            </div>
          ))}
        </div>
      )}

      {/* Selected Node Detail */}
      {selectedNode && (
        <div style={{
          marginTop: '1rem',
          padding: '1rem',
          background: 'var(--bg)',
          borderRadius: '8px',
          border: '1px solid var(--border)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <h3 style={{ fontSize: '1rem' }}>{selectedNode.label}</h3>
            <button
              onClick={() => setSelectedNode(null)}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
              }}
            >
              ✕
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.5rem', fontSize: '0.875rem' }}>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>类型: </span>
              <span>{selectedNode.type}</span>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>PID: </span>
              <span>{selectedNode.pid || '-'}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}