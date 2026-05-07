import { useMemo, useState } from 'react'
import NodePageHeader from '../common/NodePageHeader'
import { useEventStore } from '../../stores/eventStore'
import type { BufferPinEvent, ProbeEvent, XactEvent } from '../../types/events'

interface SnapshotBackend {
  pid?: string
  backend_xid?: string
  backend_xmin?: string
  state?: string
  datid?: string
  wait_event?: string
}

interface MemoryStructViewProps {
  snapshotBackends?: SnapshotBackend[]
}

interface PGProcEntry {
  pid: number
  xid: number
  vxid: string
  state: 'idle' | 'started' | 'in_progress' | 'commit' | 'abort'
  database: number
  lastEventTs: number
  waitEvent: string
}

interface PGXactEntry {
  xid: number
  state: 'idle' | 'started' | 'in_progress' | 'commit' | 'abort'
  xmin: number
  commitTs: number
}

interface BufferDescEntry {
  bufferId: number
  isDirty: boolean
  isPinned: boolean
  hitCount: number
  relfilenode: number
  blockNum: number
}

function toXactState(raw?: string): PGProcEntry['state'] {
  const map: Record<string, PGProcEntry['state']> = {
    begin: 'started',
    commit: 'commit',
    abort: 'abort',
    savepoint: 'in_progress',
    release: 'in_progress',
    rollback_to: 'in_progress',
  }
  return map[String(raw ?? '')] ?? 'idle'
}

function buildProcFromSnapshot(backends: SnapshotBackend[]): PGProcEntry[] {
  return backends
    .map((b) => ({
      pid: Number(b.pid ?? 0),
      xid: Number(b.backend_xid ?? 0),
      vxid: '',
      state: (Number(b.backend_xid ?? 0) > 0 ? 'in_progress' : 'idle') as PGProcEntry['state'],
      database: Number(b.datid ?? 0),
      lastEventTs: 0,
      waitEvent: b.wait_event ?? '',
    }))
    .filter((x) => x.pid > 0)
}

function buildProcFromEvents(events: ProbeEvent[]): PGProcEntry[] {
  const latestByPid = new Map<number, ProbeEvent>()
  for (const evt of events) {
    if (evt.type !== 'xact_state') continue
    const prev = latestByPid.get(evt.pid)
    if (!prev || evt.timestamp > prev.timestamp) latestByPid.set(evt.pid, evt)
  }

  return Array.from(latestByPid.entries()).map(([pid, evt]) => {
    const d = (evt as XactEvent).data
    return {
      pid,
      xid: Number(d.xid ?? 0),
      vxid: String(d.vxid ?? ''),
      state: toXactState(String(d.state ?? '')),
      database: 0,
      lastEventTs: evt.timestamp,
      waitEvent: '',
    }
  })
}

function buildXactFromSnapshot(backends: SnapshotBackend[]): PGXactEntry[] {
  const list: PGXactEntry[] = []
  for (const b of backends) {
    const xid = Number(b.backend_xid ?? 0)
    if (!xid) continue
    list.push({
      xid,
      state: 'in_progress',
      xmin: Number(b.backend_xmin ?? xid),
      commitTs: 0,
    })
  }
  return list
}

function buildXactFromEvents(events: ProbeEvent[]): PGXactEntry[] {
  const latestByXid = new Map<number, ProbeEvent>()
  for (const evt of events) {
    if (evt.type !== 'xact_state') continue
    const d = (evt as XactEvent).data
    const xid = Number(d.xid ?? 0)
    if (!xid) continue
    const prev = latestByXid.get(xid)
    if (!prev || evt.timestamp > prev.timestamp) latestByXid.set(xid, evt)
  }

  return Array.from(latestByXid.entries()).map(([xid, evt]) => {
    const d = (evt as XactEvent).data
    return {
      xid,
      state: toXactState(String(d.state ?? '')),
      xmin: xid,
      commitTs: d.state === 'commit' ? evt.timestamp : 0,
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
      bufferId: id,
      isDirty: false,
      isPinned: false,
      hitCount: 0,
      relfilenode: Number(d.relfilenode ?? 0),
      blockNum: Number(d.block_num ?? 0),
    }

    map.set(id, {
      ...prev,
      isPinned: true,
      hitCount: prev.hitCount + 1,
    })
  }
  return Array.from(map.values()).sort((a, b) => a.bufferId - b.bufferId)
}

function StateBadge({ state }: { state: PGProcEntry['state'] }) {
  const color = {
    idle: '#7d8590',
    started: '#58a6ff',
    in_progress: '#d29922',
    commit: '#3fb950',
    abort: '#f85149',
  }[state]
  return <span style={{ color, fontWeight: 600 }}>{state}</span>
}

export default function MemoryStructView({ snapshotBackends }: MemoryStructViewProps) {
  const events = useEventStore((s) => s.events)
  const [tab, setTab] = useState<'pgproc' | 'pgxact' | 'buffer'>('pgproc')

  const procFromSnapshot = useMemo(() => buildProcFromSnapshot(snapshotBackends ?? []), [snapshotBackends])
  const procFromEvents = useMemo(() => buildProcFromEvents(events), [events])
  const procs = procFromSnapshot.length > 0 ? procFromSnapshot : procFromEvents

  const xactFromSnapshot = useMemo(() => buildXactFromSnapshot(snapshotBackends ?? []), [snapshotBackends])
  const xactFromEvents = useMemo(() => buildXactFromEvents(events), [events])
  const xacts = xactFromSnapshot.length > 0 ? xactFromSnapshot : xactFromEvents

  const bufs = useMemo(() => buildBufferDescEntries(events), [events])
  const hasData = procs.length > 0 || xacts.length > 0 || bufs.length > 0

  return (
    <div style={{ padding: '1.5rem' }}>
      <NodePageHeader
        title="运行时内存结构"
        source="/api/snapshot + xact_state/buffer_pin 事件"
        updatedAtText={new Date().toLocaleTimeString('zh-CN', { hour12: false })}
        rightSlot={<span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{events.length} events</span>}
      />

      {!hasData && (
        <div style={{ padding: '1rem', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>
          暂无真实内存观测数据。请先连接节点并产生事务或 Buffer 相关事件。
        </div>
      )}

      {hasData && (
        <>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
            {[
              { id: 'pgproc', label: `PGPROC (${procs.length})` },
              { id: 'pgxact', label: `PGXACT (${xacts.length})` },
              { id: 'buffer', label: `BufferDesc (${bufs.length})` },
            ].map((item) => (
              <button
                key={item.id}
                onClick={() => setTab(item.id as 'pgproc' | 'pgxact' | 'buffer')}
                style={{
                  padding: '0.35rem 0.65rem',
                  borderRadius: '6px',
                  border: '1px solid var(--border)',
                  background: tab === item.id ? 'var(--accent)' : 'var(--bg-tertiary)',
                  color: tab === item.id ? '#fff' : 'var(--text)',
                  cursor: 'pointer',
                  fontSize: '0.78rem',
                }}
              >
                {item.label}
              </button>
            ))}
          </div>

          {tab === 'pgproc' && (
            <div style={{ border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                <thead>
                  <tr style={{ background: 'var(--bg-secondary)' }}>
                    {['PID', 'XID', 'VXID', '状态', '数据库', '等待事件'].map((h) => (
                      <th key={h} style={{ textAlign: 'left', padding: '0.5rem', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {procs.map((p) => (
                    <tr key={p.pid}>
                      <td style={{ padding: '0.45rem 0.5rem', fontFamily: 'monospace' }}>{p.pid}</td>
                      <td style={{ padding: '0.45rem 0.5rem', fontFamily: 'monospace' }}>{p.xid || '-'}</td>
                      <td style={{ padding: '0.45rem 0.5rem', fontFamily: 'monospace' }}>{p.vxid || '-'}</td>
                      <td style={{ padding: '0.45rem 0.5rem' }}><StateBadge state={p.state} /></td>
                      <td style={{ padding: '0.45rem 0.5rem', fontFamily: 'monospace' }}>{p.database || '-'}</td>
                      <td style={{ padding: '0.45rem 0.5rem' }}>{p.waitEvent || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'pgxact' && (
            <div style={{ border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                <thead>
                  <tr style={{ background: 'var(--bg-secondary)' }}>
                    {['XID', '状态', 'XMIN', 'CommitTs'].map((h) => (
                      <th key={h} style={{ textAlign: 'left', padding: '0.5rem', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {xacts.map((x) => (
                    <tr key={x.xid}>
                      <td style={{ padding: '0.45rem 0.5rem', fontFamily: 'monospace' }}>{x.xid}</td>
                      <td style={{ padding: '0.45rem 0.5rem' }}><StateBadge state={x.state} /></td>
                      <td style={{ padding: '0.45rem 0.5rem', fontFamily: 'monospace' }}>{x.xmin || '-'}</td>
                      <td style={{ padding: '0.45rem 0.5rem', fontFamily: 'monospace' }}>{x.commitTs || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'buffer' && (
            <div style={{ border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                <thead>
                  <tr style={{ background: 'var(--bg-secondary)' }}>
                    {['BufferID', 'RelFileNode', 'Block', '脏页', 'Pinned', '命中'].map((h) => (
                      <th key={h} style={{ textAlign: 'left', padding: '0.5rem', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {bufs.map((b) => (
                    <tr key={b.bufferId}>
                      <td style={{ padding: '0.45rem 0.5rem', fontFamily: 'monospace' }}>{b.bufferId}</td>
                      <td style={{ padding: '0.45rem 0.5rem', fontFamily: 'monospace' }}>{b.relfilenode || '-'}</td>
                      <td style={{ padding: '0.45rem 0.5rem', fontFamily: 'monospace' }}>{b.blockNum || '-'}</td>
                      <td style={{ padding: '0.45rem 0.5rem', color: b.isDirty ? '#f85149' : 'var(--text-muted)' }}>{b.isDirty ? 'Y' : 'N'}</td>
                      <td style={{ padding: '0.45rem 0.5rem', color: b.isPinned ? '#58a6ff' : 'var(--text-muted)' }}>{b.isPinned ? 'Y' : 'N'}</td>
                      <td style={{ padding: '0.45rem 0.5rem' }}>{b.hitCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
