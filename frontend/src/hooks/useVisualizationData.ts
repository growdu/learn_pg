import { useDeferredValue } from 'react'
import type { BufferCell } from '../components/buffer/BufferHeatmapView'
import type { PipelineStage } from '../components/pipeline/PipelineView'
import type { TransactionState } from '../components/transaction/TransactionStateView'
import { useEventStore } from '../stores/eventStore'
import type { BufferPinEvent, HeartbeatEvent, ProbeEvent, WALInsertEvent, XactEvent } from '../types/events'

const WRITE_STAGE_TEMPLATE: PipelineStage[] = [
  { id: 'parse', name: 'Parser', label: 'SQL 解析', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#58a6ff' },
  { id: 'bind', name: 'Binder', label: '参数绑定', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#bc8cff' },
  { id: 'plan', name: 'Planner', label: '执行计划', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#d29922' },
  { id: 'exec_start', name: 'ExecutorStart', label: '执行器启动', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#3fb950' },
  { id: 'tuple_form', name: 'heap_form_tuple', label: '元组构建', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#f0883e' },
  { id: 'buf_alloc', name: 'BufferAlloc', label: 'Buffer 分配', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#f85149' },
  { id: 'wal_insert', name: 'XLogInsert', label: 'WAL 写入', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#ff7b72' },
  { id: 'page_modify', name: 'PageAddItem', label: '数据页修改', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#a371f7' },
  { id: 'clog_update', name: 'TransactionLogUpdate', label: 'CLOG 更新', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#7ee787' },
  { id: 'commit', name: 'Commit', label: '提交完成', duration_us: 0, start_us: 0, end_us: 0, status: 'pending', details: {}, color: '#39d353' },
]

const transactionStateMap: Record<string, TransactionState['state']> = {
  begin: 'started',
  commit: 'commit',
  abort: 'abort',
}

function asWalEvent(event: ProbeEvent): WALInsertEvent | null {
  return event.type === 'wal_insert' ? (event as WALInsertEvent) : null
}

function asBufferEvent(event: ProbeEvent): BufferPinEvent | null {
  return event.type === 'buffer_pin' ? (event as BufferPinEvent) : null
}

function asXactEvent(event: ProbeEvent): XactEvent | null {
  return event.type === 'xact_state' ? (event as XactEvent) : null
}

function asHeartbeatEvent(event: ProbeEvent): HeartbeatEvent | null {
  return event.type === 'heartbeat' ? (event as HeartbeatEvent) : null
}

function buildBufferCells(events: ProbeEvent[]): BufferCell[] {
  const aggregate = new Map<number, BufferCell>()

  for (const event of events) {
    const bufferEvent = asBufferEvent(event)
    if (!bufferEvent) continue

    const bufferID = Number(bufferEvent.data.buffer_id ?? 0)
    const current = aggregate.get(bufferID)
    aggregate.set(bufferID, {
      buffer_id: bufferID,
      hit_count: (current?.hit_count ?? 0) + 1,
      is_dirty: current?.is_dirty ?? false,
      is_pinned: true,
      relfilenode: Number(bufferEvent.data.relfilenode ?? current?.relfilenode ?? 0),
    })
  }

  return Array.from(aggregate.values()).sort((a, b) => a.buffer_id - b.buffer_id)
}

function buildTransactionStates(events: ProbeEvent[]): TransactionState[] {
  return events
    .map(asXactEvent)
    .filter((event): event is XactEvent => Boolean(event))
    .map((event) => ({
      xid: Number(event.data.xid ?? 0),
      vxid: String(event.data.vxid ?? ''),
      state: transactionStateMap[String(event.data.state ?? '')] ?? 'in_progress',
      start_time_us: event.timestamp,
      end_time_us: event.timestamp,
      lsn: typeof event.data.lsn === 'string' ? event.data.lsn : undefined,
    }))
}

function buildWriteStages(events: ProbeEvent[]): PipelineStage[] | undefined {
  const latestWal = [...events].reverse().find(asWalEvent)
  const latestBuffer = [...events].reverse().find(asBufferEvent)
  const latestXact = [...events].reverse().find(asXactEvent)
  if (!latestWal && !latestBuffer && !latestXact) {
    return undefined
  }

  return WRITE_STAGE_TEMPLATE.map((stage) => {
    switch (stage.id) {
      case 'exec_start':
        if (latestWal || latestBuffer || latestXact) {
          return { ...stage, status: 'done', details: { source: 'runtime event stream' } }
        }
        return stage
      case 'buf_alloc':
        if (latestBuffer) {
          return {
            ...stage,
            status: 'done',
            details: {
              buffer_id: Number(latestBuffer.data.buffer_id ?? 0),
              relfilenode: Number(latestBuffer.data.relfilenode ?? 0),
              block_num: Number(latestBuffer.data.block_num ?? 0),
            },
          }
        }
        return stage
      case 'wal_insert':
        if (latestWal) {
          return {
            ...stage,
            status: 'done',
            details: {
              xlog_ptr: String(latestWal.data.xlog_ptr ?? ''),
              rmgr_name: String(latestWal.data.rmgr_name ?? ''),
              operation: String(latestWal.data.operation ?? ''),
              xid: Number(latestWal.data.xid ?? 0),
              record_len: Number(latestWal.data.record_len ?? 0),
              source: String(latestWal.data.source ?? ''),
            },
          }
        }
        return stage
      case 'clog_update':
      case 'commit':
        if (latestXact && latestXact.data.state === 'commit') {
          return {
            ...stage,
            status: 'done',
            details: {
              xid: Number(latestXact.data.xid ?? 0),
              state: String(latestXact.data.state ?? ''),
              lsn: String(latestXact.data.lsn ?? ''),
            },
          }
        }
        if (latestXact && latestXact.data.state === 'abort') {
          return {
            ...stage,
            status: 'error',
            details: {
              xid: Number(latestXact.data.xid ?? 0),
              state: String(latestXact.data.state ?? ''),
            },
          }
        }
        return stage
      default:
        return stage
    }
  })
}

export function useVisualizationData() {
  const events = useEventStore((state) => state.events)
  const deferredEvents = useDeferredValue(events)

  const heartbeat = [...deferredEvents].reverse().find(asHeartbeatEvent)
  const latestEvent = deferredEvents[deferredEvents.length - 1]

  return {
    buffers: buildBufferCells(deferredEvents),
    collectorMode: typeof heartbeat?.data.mode === 'string' ? heartbeat.data.mode : 'unknown',
    eventCount: deferredEvents.length,
    lastEventType: latestEvent?.type ?? '',
    transactions: buildTransactionStates(deferredEvents),
    writeStages: buildWriteStages(deferredEvents),
  }
}
