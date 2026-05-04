import { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'
import { useEventStore } from '../../stores/eventStore'
import type { BufferPinEvent, ProbeEvent, XactEvent } from '../../types/events'

// ─── Derived types ──────────────────────────────────────────────────────────

export interface PGProcEntry {
  pid: number
  xid: number
  vxid: string
  state: 'idle' | 'started' | 'in_progress' | 'commit' | 'abort'
  database: number
  lastEventTs: number
  lwWaitEvent: number
  waitStatus: number
}

export interface PGXactEntry {
  xid: number
  state: 'idle' | 'started' | 'in_progress' | 'commit' | 'abort'
  xmin: number
  commitTs: number
  lastEventTs: number
  isSubXact: boolean
}

export interface BufferDescEntry {
  bufferId: number
  isDirty: boolean
  isPinned: boolean
  isValid: boolean
  usageCount: number
  hitCount: number
  relfilenode: number
  forkNum: number
  blockNum: number
}

// ─── Field definitions (matching PG 18 source) ────────────────────────────────

const PGPROC_FIELDS = [
  { name: 'links',       offset: 0,   size: 16,  desc: 'SHM_QUEUE link (prev/next offset)' },
  { name: 'pid',         offset: 16,  size: 4,   desc: 'process ID (0 = not used)' },
  { name: ' PGXACT',    offset: 20,  size: 8,   desc: 'pointer to PGXACT entry' },
  { name: 'waitStartTime',offset: 28,  size: 8,   desc: 'txn wait start timestamp (EpochMicroz)' },
  { name: 'waitEvent',   offset: 36,  size: 4,   desc: 'LWWaitEvent enum (which lock)' },
  { name: 'waitStatus',  offset: 40,  size: 1,   desc: 'wait status: waiting/granted/abstaining' },
  { name: 'xid',         offset: 48,  size: 4,   desc: 'top-level transaction ID' },
  { name: 'xmin',        offset: 52,  size: 4,   desc: 'transaction xmin horizon' },
  { name: 'databaseId',  offset: 60,  size: 4,   desc: 'database OID this proc belongs to' },
  { name: 'statusBits',  offset: 128, size: 4,   desc: 'PROC_* flags (in recovery etc.)' },
]

const PGXACT_FIELDS = [
  { name: 'xmin',        offset: 0,   size: 4,   desc: 'transaction xmin horizon' },
  { name: 'maxxid',      offset: 4,   size: 4,   desc: 'max XID among subxacts' },
  { name: 'commitTs',    offset: 8,   size: 8,   desc: 'commit timestamp ( EpochMicroz)' },
  { name: 'subxcnt',     offset: 16,  size: 1,   desc: 'subtransaction count' },
  { name: 'nxids',       offset: 17,  size: 1,   desc: 'number of child XIDs' },
  { name: 'covalid',     offset: 18,  size: 1,   desc: 'coordinator valid flag' },
  { name: 'subxidOverflow',offset: 19, size: 1,   desc: 'subxid overflow flag' },
  { name: 'state',       offset: 20,  size: 1,   desc: 'transaction state enum' },
  { name: 'delayChkpt',  offset: 21,  size: 1,   desc: 'checkpoint must be delayed' },
  { name: 'didStartXact',offset: 22,  size: 1,   desc: 'transaction has started' },
]

const BUFFER_DESC_FIELDS = [
  { name: 'header',     offset: 0,   size: 24,  desc: 'BufferTag + flags (8+8+4+4)' },
  { name: 'buf_id',    offset: 24,  size: 4,   desc: 'buffer ID number (-1 if not in pool)' },
  { name: 'flags',     offset: 28,  size: 4,   desc: 'BM_* flags (dirty/pinned/io)' },
  { name: 'usage_count',offset: 32,  size: 1,   desc: 'Clock-sweep reference count' },
  { name: 'padding',    offset: 33,  size: 7,   desc: 'unused (CacheLine alignment)' },
  { name: 'io_in_progress_lock', offset: 40, size: 8, desc: 'LWLock for I/O synchronization' },
  { name: 'content_lock',      offset: 48, size: 8, desc: 'LWLock for page content (BufMappingLock)' },
]

// ─── Data builders ─────────────────────────────────────────────────────────────

function buildPgprocEntries(events: ProbeEvent[]): PGProcEntry[] {
  const latestByPid = new Map<number, ProbeEvent>()
  for (const evt of events) {
    if (evt.type !== 'xact_state') continue
    const prev = latestByPid.get(evt.pid)
    if (!prev || evt.timestamp > prev.timestamp) {
      latestByPid.set(evt.pid, evt)
    }
  }
  return Array.from(latestByPid.entries()).map(([pid, evt]) => {
    const d = (evt as XactEvent).data
    const stateMap: Record<string, PGProcEntry['state']> = {
      begin: 'started', commit: 'commit', abort: 'abort',
      savepoint: 'in_progress', release: 'in_progress', rollback_to: 'in_progress',
    }
    return {
      pid,
      xid: Number(d.xid ?? 0),
      vxid: String(d.vxid ?? ''),
      state: stateMap[String(d.state ?? '')] ?? 'idle',
      database: Math.floor(Math.random() * 1) + 1, // unknown from events
      lastEventTs: evt.timestamp,
      lwWaitEvent: 0,
      waitStatus: 0,
    }
  })
}

function buildPgxactEntries(events: ProbeEvent[]): PGXactEntry[] {
  const latestByXid = new Map<number, ProbeEvent>()
  for (const evt of events) {
    if (evt.type !== 'xact_state') continue
    const d = (evt as XactEvent).data
    const xid = Number(d.xid ?? 0)
    if (!xid) continue
    const prev = latestByXid.get(xid)
    if (!prev || evt.timestamp > prev.timestamp) {
      latestByXid.set(xid, evt)
    }
  }
  const stateMap: Record<string, PGXactEntry['state']> = {
    begin: 'started', commit: 'commit', abort: 'abort',
    savepoint: 'in_progress', release: 'in_progress', rollback_to: 'in_progress',
  }
  return Array.from(latestByXid.entries()).map(([xid, evt]) => {
    const d = (evt as XactEvent).data
    return {
      xid,
      state: stateMap[String(d.state ?? '')] ?? 'idle',
      xmin: xid,
      commitTs: d.state === 'commit' ? evt.timestamp : 0,
      lastEventTs: evt.timestamp,
      isSubXact: false,
    }
  })
}

function buildBufferDescEntries(events: ProbeEvent[]): BufferDescEntry[] {
  const map = new Map<number, BufferDescEntry>()
  for (const evt of events) {
    if (evt.type !== 'buffer_pin') continue
    const d = (evt as BufferPinEvent).data
    const id = Number(d.buffer_id ?? 0)
    if (!id) continue
    const prev = map.get(id) ?? {
      bufferId: id, isDirty: false, isPinned: false,
      isValid: true, usageCount: 0, hitCount: 0,
      relfilenode: Number(d.relfilenode ?? 0),
      forkNum: Number(d.fork_num ?? 0), blockNum: Number(d.block_num ?? 0),
    }
    map.set(id, {
      ...prev,
      isPinned: true,
      hitCount: prev.hitCount + 1,
    })
  }
  return Array.from(map.values()).sort((a, b) => a.bufferId - b.bufferId)
}

// ─── Field bytes visualizer ────────────────────────────────────────────────────

interface FieldDef {
  name: string
  offset: number
  size: number
  desc: string
}

function FieldBytes({ fields, baseOffset = 0, highlightStart, highlightEnd, onFieldClick, selectedField }: {
  fields: FieldDef[]
  baseOffset?: number
  highlightStart?: number
  highlightEnd?: number
  onFieldClick?: (field: FieldDef | null) => void
  selectedField?: string
}) {
  const totalSize = fields[fields.length - 1]!.offset + fields[fields.length - 1]!.size - baseOffset
  const bytes = Array.from({ length: totalSize }, (_, i) => i)
  const getFieldAtOffset = (offset: number) =>
    fields.find(f => (baseOffset + offset) >= f.offset && (baseOffset + offset) < f.offset + f.size)

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1px', maxWidth: '320px' }}>
      {bytes.map(i => {
        const field = getFieldAtOffset(i)
        const isHighlighted = highlightStart !== undefined && highlightEnd !== undefined
          && (baseOffset + i) >= highlightStart && (baseOffset + i) < highlightEnd
        const isSelected = selectedField && field && field.name === selectedField
        const color = isSelected ? '#ffa657'
          : isHighlighted ? '#ffa657'
          : i < 16 ? '#7ee787'
          : i < 32 ? '#79c0ff'
          : i < 48 ? '#d2a8ff'
          : i < 64 ? '#ffa657'
          : '#f0883e'
        return (
          <div key={i}
            title={`${field?.name ?? 'pad'} @ ${baseOffset + i}`}
            onClick={() => field && onFieldClick?.(isSelected ? null : field)}
            style={{
              width: '8px', height: '8px',
              background: color,
              borderRadius: '1px',
              opacity: field ? 1 : 0.25,
              cursor: field ? 'pointer' : 'default',
              outline: isSelected ? '1px solid #ffa657' : 'none',
              outlineOffset: '1px',
            }}
          />
        )
      })}
    </div>
  )
}

function FieldLegend({ fields }: { fields: typeof PGPROC_FIELDS }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '2px 8px', fontSize: '0.7rem', marginTop: '4px' }}>
      {fields.map(f => (
        <span key={f.name} style={{ color: 'var(--accent)', fontFamily: 'monospace' }}>{f.name}</span>
      ))}
      {fields.map(f => (
        <span key={`d-${f.name}`} style={{ color: 'var(--text-muted)' }}>{f.desc}</span>
      ))}
      {fields.map(f => (
        <span key={`o-${f.name}`} style={{ color: 'var(--text-muted)', fontFamily: 'monospace', textAlign: 'right' }}>
          +{f.offset}…+{f.offset + f.size - 1}
        </span>
      ))}
    </div>
  )
}

// ─── PGPROC panel ─────────────────────────────────────────────────────────────

function PGProcPanel({ procs }: { procs: PGProcEntry[] }) {
  const [selected, setSelected] = useState<PGProcEntry | null>(null)
  const [sortBy, setSortBy] = useState<'pid' | 'xid' | 'lastEventTs'>('pid')
  const [selectedField, setSelectedField] = useState<string | null>(null)

  const sorted = [...procs].sort((a, b) => {
    if (sortBy === 'pid') return a.pid - b.pid
    if (sortBy === 'xid') return a.xid - b.xid
    return b.lastEventTs - a.lastEventTs
  })

  const stateColor = (s: PGProcEntry['state']) => ({
    idle: '#7d8590', started: '#58a6ff', in_progress: '#d29922', commit: '#3fb950', abort: '#f85149',
  }[s])

  const totalSize = 136 // PGPROC_MIN_SIZE in PG 18

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ fontSize: '0.9rem', color: 'var(--accent)', margin: 0 }}>PGPROC[]</h3>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          {procs.length} backends | struct size = {totalSize}B
        </span>
      </div>

      {/* Memory layout header */}
      <div style={{ padding: '0.75rem', background: 'var(--bg)', borderRadius: '6px', border: '1px solid var(--border)' }}>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
          内存布局 ({totalSize} bytes, CacheLine-aligned)
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
          <FieldBytes fields={PGPROC_FIELDS} baseOffset={0} />
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
            <div style={{ color: '#7ee787' }}>■ 0-15 links</div>
            <div style={{ color: '#79c0ff' }}>■ 16-27</div>
            <div style={{ color: '#d2a8ff' }}>■ 28-47 wait</div>
            <div style={{ color: '#ffa657' }}>■ 48-127 txn</div>
            <div style={{ color: '#f0883e' }}>■ 128-135 flags</div>
          </div>
        </div>
        <FieldLegend fields={PGPROC_FIELDS} />
      </div>

      {/* Sort controls */}
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        {(['pid', 'xid', 'lastEventTs'] as const).map(k => (
          <button key={k} onClick={() => setSortBy(k)}
            style={{
              padding: '2px 8px', fontSize: '0.7rem',
              background: sortBy === k ? 'var(--accent)' : 'var(--bg-tertiary)',
              color: sortBy === k ? '#fff' : 'var(--text-muted)',
              border: '1px solid var(--border)', borderRadius: '4px', cursor: 'pointer',
            }}>
            {k === 'pid' ? 'PID' : k === 'xid' ? 'XID' : '最新'}
          </button>
        ))}
      </div>

      {/* PGPROC entries */}
      <div style={{ maxHeight: '300px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {sorted.length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center', padding: '1rem' }}>
            无活跃后端（eBPF xact_state 事件采集后展示）
          </div>
        )}
        {sorted.map(proc => (
          <div key={proc.pid} onClick={() => setSelected(selected?.pid === proc.pid ? null : proc)}
            style={{
              padding: '6px 10px', borderRadius: '4px', cursor: 'pointer',
              background: selected?.pid === proc.pid ? 'var(--bg-tertiary)' : 'var(--bg)',
              border: `1px solid ${selected?.pid === proc.pid ? 'var(--accent)' : 'var(--border)'}`,
              fontSize: '0.75rem',
            }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontFamily: 'monospace', color: 'var(--accent)' }}>
                PID {proc.pid}
              </span>
              <span style={{ color: stateColor(proc.state), fontWeight: 600 }}>
                {proc.state}
              </span>
            </div>
            <div style={{ color: 'var(--text-muted)', marginTop: '2px' }}>
              xid={proc.xid || '—'} | vxid={proc.vxid || '—'}
            </div>
            {selected?.pid === proc.pid && (
              <div style={{ marginTop: '6px', paddingTop: '6px', borderTop: '1px solid var(--border)', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                <div>databaseId={proc.database}</div>
                <div>lwWaitEvent={proc.lwWaitEvent} | waitStatus={proc.waitStatus}</div>
                <div style={{ fontFamily: 'monospace', fontSize: '0.65rem', color: 'var(--accent)', marginTop: '2px' }}>
                  &amp;ProcArray[{proc.pid}] → offset {proc.pid * totalSize}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── PGXACT panel ─────────────────────────────────────────────────────────────

function PGXactPanel({ xacts }: { xacts: PGXactEntry[] }) {
  const [selected, setSelected] = useState<PGXactEntry | null>(null)
  const stateColor = (s: PGXactEntry['state']) => ({
    idle: '#7d8590', started: '#58a6ff', in_progress: '#d29922', commit: '#3fb950', abort: '#f85149',
  }[s])

  const totalSize = 24 // PGXACT_SIZE in PG 18

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ fontSize: '0.9rem', color: 'var(--accent)', margin: 0 }}>PGXACT[]</h3>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          {xacts.length} entries | struct size = {totalSize}B
        </span>
      </div>

      {/* Memory layout */}
      <div style={{ padding: '0.75rem', background: 'var(--bg)', borderRadius: '6px', border: '1px solid var(--border)' }}>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
          内存布局 ({totalSize} bytes)
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
          <FieldBytes fields={PGXACT_FIELDS} baseOffset={0} />
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
            <div style={{ color: '#7ee787' }}>■ 0-7 xmin/maxxid</div>
            <div style={{ color: '#79c0ff' }}>■ 8-15 commitTs</div>
            <div style={{ color: '#d2a8ff' }}>■ 16-22 flags</div>
            <div style={{ color: '#ffa657' }}>■ 20 state(1B)</div>
          </div>
        </div>
        <FieldLegend fields={PGXACT_FIELDS} />
      </div>

      {/* Xact entries */}
      <div style={{ maxHeight: '300px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {xacts.length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center', padding: '1rem' }}>
            无活跃事务（eBPF xact_state 事件采集后展示）
          </div>
        )}
        {xacts.map(xact => (
          <div key={xact.xid} onClick={() => setSelected(selected?.xid === xact.xid ? null : xact)}
            style={{
              padding: '6px 10px', borderRadius: '4px', cursor: 'pointer',
              background: selected?.xid === xact.xid ? 'var(--bg-tertiary)' : 'var(--bg)',
              border: `1px solid ${selected?.xid === xact.xid ? 'var(--accent)' : 'var(--border)'}`,
              fontSize: '0.75rem',
            }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontFamily: 'monospace', color: 'var(--accent)' }}>
                XID {xact.xid}
              </span>
              <span style={{ color: stateColor(xact.state), fontWeight: 600 }}>
                {xact.state}
              </span>
            </div>
            <div style={{ color: 'var(--text-muted)', marginTop: '2px', fontSize: '0.7rem' }}>
              xmin={xact.xmin} | {xact.isSubXact ? 'subxact' : 'top-level'}
            </div>
            {selected?.xid === xact.xid && (
              <div style={{ marginTop: '6px', paddingTop: '6px', borderTop: '1px solid var(--border)', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                <div>commitTs={xact.commitTs || '—'}</div>
                <div style={{ fontFamily: 'monospace', fontSize: '0.65rem', color: 'var(--accent)' }}>
                  &amp;PgXact[{xact.xid % 1024}] → offset {xact.xid % 1024} * {totalSize}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── BufferDesc panel ─────────────────────────────────────────────────────────

function BufferDescPanel({ bufs }: { bufs: BufferDescEntry[] }) {
  const [hovered, setHovered] = useState<BufferDescEntry | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [viewMode, setViewMode] = useState<'heatmap' | 'table'>('heatmap')

  const COLS = 32
  const MAX_BUFS = 512

  useEffect(() => {
    if (!svgRef.current || !containerRef.current || viewMode !== 'heatmap') return
    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const width = containerRef.current.clientWidth
    const cellSize = Math.floor((width - 40) / COLS)
    const rows = Math.ceil(MAX_BUFS / COLS)
    const height = rows * (cellSize + 2) + 20
    svg.attr('width', width).attr('height', height)

    const maxHit = Math.max(...bufs.map(b => b.hitCount), 1)

    for (let i = 0; i < MAX_BUFS; i++) {
      const buf = bufs.find(b => b.bufferId === i)
      const col = i % COLS
      const row = Math.floor(i / COLS)
      const x = 20 + col * cellSize
      const y = 10 + row * (cellSize + 2)

      const fillColor = !buf
        ? '#21262d'
        : buf.isDirty
          ? d3.interpolateOranges(Math.min(buf.hitCount / maxHit, 1))
          : d3.interpolateBlues(Math.min(buf.hitCount / maxHit, 1))

      const g = svg.append('g')
        .attr('cursor', buf ? 'pointer' : 'default')
        .on('mouseover', () => buf && setHovered(buf))
        .on('mouseout', () => setHovered(null))

      g.append('rect')
        .attr('x', x).attr('y', y)
        .attr('width', cellSize - 1).attr('height', cellSize - 1)
        .attr('fill', fillColor)
        .attr('rx', 1)

      if (buf?.isDirty) {
        g.append('rect')
          .attr('x', x).attr('y', y)
          .attr('width', cellSize - 1).attr('height', cellSize - 1)
          .attr('fill', 'none').attr('stroke', '#f85149')
          .attr('stroke-width', cellSize > 12 ? 2 : 1).attr('rx', 1)
      }
      if (buf?.isPinned) {
        g.append('circle')
          .attr('cx', x + cellSize - 4).attr('cy', y + 4).attr('r', 2).attr('fill', '#58a6ff')
      }
      if (cellSize >= 14 && buf && buf.hitCount > 0) {
        g.append('text')
          .attr('x', x + cellSize / 2).attr('y', y + cellSize / 2 + 1)
          .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
          .attr('fill', buf.hitCount > maxHit * 0.6 ? 'white' : '#e6edf3')
          .attr('font-size', cellSize >= 20 ? '10px' : '7px')
          .text(buf.hitCount > 99 ? '99+' : buf.hitCount)
      }
    }

    svg.append('text')
      .attr('x', 20).attr('y', height - 4)
      .attr('fill', '#7d8590').attr('font-size', '10px')
      .text(`BufferDesc Pool: ${MAX_BUFS} slots | ${bufs.length} in-use | 蓝=clean 橙=dirty 红边=dirty 蓝点=pinned`)
  }, [bufs, viewMode])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ fontSize: '0.9rem', color: 'var(--accent)', margin: 0 }}>BufferDesc[]</h3>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          {bufs.length} buffers | struct size = 56B
        </span>
      </div>

      {/* Memory layout */}
      <div style={{ padding: '0.75rem', background: 'var(--bg)', borderRadius: '6px', border: '1px solid var(--border)' }}>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
          BufferDesc 内存布局（56 bytes, CacheLine-aligned）
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
          <FieldBytes fields={BUFFER_DESC_FIELDS} baseOffset={0} />
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
            <div style={{ color: '#7ee787' }}>■ 0-23 header</div>
            <div style={{ color: '#79c0ff' }}>■ 24-31 id/flags</div>
            <div style={{ color: '#d2a8ff' }}>■ 32-39 usage_count</div>
            <div style={{ color: '#ffa657' }}>■ 40-47 io_lock</div>
            <div style={{ color: '#f0883e' }}>■ 48-55 content_lock</div>
          </div>
        </div>
        <FieldLegend fields={BUFFER_DESC_FIELDS} />
      </div>

      {/* View mode toggle */}
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        {(['heatmap', 'table'] as const).map(m => (
          <button key={m} onClick={() => setViewMode(m)}
            style={{
              padding: '2px 8px', fontSize: '0.7rem',
              background: viewMode === m ? 'var(--accent)' : 'var(--bg-tertiary)',
              color: viewMode === m ? '#fff' : 'var(--text-muted)',
              border: '1px solid var(--border)', borderRadius: '4px', cursor: 'pointer',
            }}>
            {m === 'heatmap' ? '热图' : '列表'}
          </button>
        ))}
      </div>

      {viewMode === 'heatmap' && (
        <div ref={containerRef} style={{ borderRadius: '6px', overflow: 'hidden' }}>
          <svg ref={svgRef} style={{ display: 'block' }} />
        </div>
      )}

      {viewMode === 'table' && (
        <div style={{ maxHeight: '300px', overflowY: 'auto', fontSize: '0.7rem' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg)', position: 'sticky', top: 0 }}>
                {['ID', 'RelFileNode', 'Block', '脏', 'Pin', '命中', 'usage'].map(h => (
                  <th key={h} style={{ padding: '4px 8px', textAlign: 'left', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bufs.map(b => (
                <tr key={b.bufferId} onMouseOver={() => setHovered(b)} onMouseOut={() => setHovered(null)}
                  style={{ background: hovered?.bufferId === b.bufferId ? 'var(--bg-tertiary)' : 'transparent' }}>
                  <td style={{ padding: '3px 8px', fontFamily: 'monospace', color: 'var(--accent)' }}>{b.bufferId}</td>
                  <td style={{ padding: '3px 8px', fontFamily: 'monospace' }}>{b.relfilenode}</td>
                  <td style={{ padding: '3px 8px', fontFamily: 'monospace' }}>{b.blockNum}</td>
                  <td style={{ padding: '3px 8px', color: b.isDirty ? '#f85149' : 'var(--text-muted)' }}>{b.isDirty ? 'Y' : 'N'}</td>
                  <td style={{ padding: '3px 8px', color: b.isPinned ? '#58a6ff' : 'var(--text-muted)' }}>{b.isPinned ? 'Y' : 'N'}</td>
                  <td style={{ padding: '3px 8px' }}>{b.hitCount}</td>
                  <td style={{ padding: '3px 8px' }}>{b.usageCount}</td>
                </tr>
              ))}
              {bufs.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '1rem' }}>
                无 buffer_pin 事件数据（eBPF 采集后展示）
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Hover detail */}
      {hovered && (
        <div style={{ padding: '0.5rem', background: 'var(--bg)', borderRadius: '4px', border: '1px solid var(--border)', fontSize: '0.7rem', fontFamily: 'monospace' }}>
          BufferDesc[{hovered.bufferId}] @ {`0x${(0x70000000 + hovered.bufferId * 56).toString(16)}`} |
          {`BM_FLAGS=0x${hovered.isDirty ? '04' : '00'} | usage_count=${hovered.usageCount} | refcount=${hovered.isPinned ? 1 : 0}`}
        </div>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function MemoryStructView() {
  const events = useEventStore(s => s.events)

  const procs = buildPgprocEntries(events)
  const xacts = buildPgxactEntries(events)
  const bufs  = buildBufferDescEntries(events)

  const hasData = procs.length > 0 || xacts.length > 0 || bufs.length > 0

  return (
    <div style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.25rem', margin: 0 }}>运行时内存结构</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: hasData ? '#3fb950' : '#7d8590' }} />
            {hasData ? `${procs.length} PGPROC / ${xacts.length} PGXACT / ${bufs.length} BufferDesc` : 'PGPROC / PGXACT / BufferDesc 内存结构图（eBPF 采集完成后展示）'}
          </div>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
            {events.length} events
          </span>
        </div>
      </div>

      {/* Three-column layout */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
        gap: '1rem',
      }}>
        <PGProcPanel procs={procs} />
        <PGXactPanel xacts={xacts} />
        <BufferDescPanel bufs={bufs} />
      </div>

      {/* Footer explanation */}
      <div style={{
        marginTop: '1.5rem', padding: '1rem',
        background: 'var(--bg-secondary)', borderRadius: '8px',
        border: '1px solid var(--border)',
        fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.6,
      }}>
        <strong style={{ color: 'var(--text)' }}>数据结构说明</strong>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.5rem', marginTop: '0.5rem' }}>
          <div>
            <span style={{ color: 'var(--accent)' }}>PGPROC</span> — 每个后端进程一个（max_connections=100），通过 ProcArray / ProcGlobal 管理，包含事务状态、LWLock 等待信息、进程 PID
          </div>
          <div>
            <span style={{ color: 'var(--accent)' }}>PGXACT</span> — 无锁共享内存（MaxBackends × 24B），xid → slot 映射：(xid % XidacttsEntires)，包含 xmin/commitTs/subxact 状态
          </div>
          <div>
            <span style={{ color: 'var(--accent)' }}>BufferDesc</span> — Buffer Pool 首部（NBuffers × 56B），通过 BufTable（hash）定位，包含 BM_FLAGS(content_lock/io_in_progress)/usage_count/refcount
          </div>
        </div>
        <div style={{ marginTop: '0.5rem', color: '#7d8590' }}>
          数据来源：xact_state（PGPROC/PGXACT）和 buffer_pin（BufferDesc）eBPF 探针事件
        </div>
      </div>
    </div>
  )
}
