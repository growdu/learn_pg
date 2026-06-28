// src/hooks/useVisualizationData.test.ts
//
// Unit tests for the visualisation-data derivation hook. The hook is
// pure: it reads events from useEventStore and produces aggregated
// buffer / transaction / pipeline views. We seed the store directly
// via setEvents and assert on the returned shapes.
//
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ProbeEvent } from '../types/events'
import { useEventStore } from '../stores/eventStore'
import {
  buildBufferCells,
  buildTransactionStates,
  buildWriteStages,
  useVisualizationData,
} from './useVisualizationData'

// ---------- event helpers ----------

const ts = (i: number) => 1_700_000_000_000_000 + i

function wal(i: number, overrides: Partial<ProbeEvent['data']> = {}) {
  return {
    type: 'wal_insert',
    timestamp: ts(i),
    pid: 100 + i,
    seq: i,
    data: {
      xlog_ptr: `0/1${i}`,
      record_len: 64,
      rmgr_id: 10,
      rmgr_name: 'Heap',
      info: 0,
      xid: 42,
      ...overrides,
    },
  } as unknown as ProbeEvent
}

function buf(i: number, overrides: Partial<ProbeEvent['data']> = {}) {
  return {
    type: 'buffer_pin',
    timestamp: ts(i),
    pid: 200 + i,
    seq: i,
    data: {
      buffer_id: i,
      is_hit: true,
      relfilenode: 16384,
      fork_num: 0,
      block_num: 0,
      ...overrides,
    },
  } as unknown as ProbeEvent
}

function xact(i: number, state: 'begin' | 'commit' | 'abort', xid = 7) {
  return {
    type: 'xact_state',
    timestamp: ts(i),
    pid: 300 + i,
    seq: i,
    data: { xid, vxid: `vxid/${xid}`, state, lsn: '0/200' },
  } as unknown as ProbeEvent
}

function heartbeat(i: number, mode: string) {
  return {
    type: 'heartbeat',
    timestamp: ts(i),
    pid: 1,
    seq: i,
    data: { mode },
  } as unknown as ProbeEvent
}

// ---------- lifecycle ----------

beforeEach(() => {
  act(() => {
    useEventStore.setState({ events: [] })
  })
})

afterEach(() => {
  act(() => {
    useEventStore.setState({ events: [] })
  })
})

// ---------- the hook ----------

describe('useVisualizationData', () => {
  it('returns sensible defaults when the store is empty', () => {
    const { result } = renderHook(() => useVisualizationData())
    expect(result.current.buffers).toEqual([])
    expect(result.current.transactions).toEqual([])
    expect(result.current.writeStages).toBeUndefined()
    expect(result.current.collectorMode).toBe('unknown')
    expect(result.current.eventCount).toBe(0)
    expect(result.current.lastEventType).toBe('')
  })

  it('reports the latest event type and the total event count', () => {
    act(() => useEventStore.getState().setEvents([wal(0), buf(1), xact(2, 'begin')]))
    const { result } = renderHook(() => useVisualizationData())
    expect(result.current.eventCount).toBe(3)
    expect(result.current.lastEventType).toBe('xact_state')
  })

  it('surfaces the heartbeat collector mode from the most recent heartbeat', () => {
    act(() =>
      useEventStore.getState().setEvents([
        heartbeat(0, 'idle'),
        wal(1),
        heartbeat(2, 'probing'),
      ]),
    )
    const { result } = renderHook(() => useVisualizationData())
    expect(result.current.collectorMode).toBe('probing')
  })

  it('passes empty-string heartbeat modes through as-is', () => {
    // An empty string is still a string per typeof, so we surface
    // it verbatim. Only a missing/typed-wrong mode falls back.
    act(() => useEventStore.getState().setEvents([heartbeat(0, '')]))
    const { result } = renderHook(() => useVisualizationData())
    expect(result.current.collectorMode).toBe('')
  })
})

// ---------- buildBufferCells ----------

describe('buildBufferCells', () => {
  it('aggregates hit_count per buffer_id and sorts by id', () => {
    const cells = buildBufferCells([
      buf(5),
      buf(2),
      buf(5), // second hit on buffer 5
      buf(5), // third hit on buffer 5
      buf(2), // second hit on buffer 2
      wal(0), // unrelated event type — ignored
    ])
    expect(cells).toHaveLength(2)
    expect(cells.map((c) => c.buffer_id)).toEqual([2, 5])
    const byId = Object.fromEntries(cells.map((c) => [c.buffer_id, c]))
    expect(byId[2].hit_count).toBe(2)
    expect(byId[5].hit_count).toBe(3)
  })

  it('marks every aggregated cell as pinned (latest event wins)', () => {
    const cells = buildBufferCells([buf(1), buf(1)])
    expect(cells).toHaveLength(1)
    expect(cells[0].is_pinned).toBe(true)
  })

  it('preserves relfilenode when present in the event', () => {
    const cells = buildBufferCells([buf(9, { relfilenode: 12345 })])
    expect(cells[0].relfilenode).toBe(12345)
  })

  it('defaults relfilenode to 0 when the event omits it', () => {
    const cells = buildBufferCells([{ ...buf(11), data: { buffer_id: 11 } } as ProbeEvent])
    expect(cells[0].relfilenode).toBe(0)
  })

  it('returns an empty array when no buffer_pin events exist', () => {
    expect(buildBufferCells([wal(0), heartbeat(1, 'a')])).toEqual([])
  })
})

// ---------- buildTransactionStates ----------

describe('buildTransactionStates', () => {
  it('maps begin/commit/abort to the expected transaction state', () => {
    const states = buildTransactionStates([
      xact(0, 'begin', 1),
      xact(1, 'commit', 1),
      xact(2, 'abort', 2),
    ])
    expect(states.map((s) => s.state)).toEqual(['started', 'commit', 'abort'])
    expect(states.map((s) => s.xid)).toEqual([1, 1, 2])
  })

  it('falls back to in_progress for unknown state values', () => {
    const states = buildTransactionStates([
      { ...xact(0, 'begin' as 'begin'), data: { xid: 1, vxid: 'v', state: 'weird' as 'begin' } } as ProbeEvent,
    ])
    expect(states[0].state).toBe('in_progress')
  })

  it('passes through lsn when it is a string', () => {
    const states = buildTransactionStates([xact(0, 'commit', 9)])
    expect(states[0].lsn).toBe('0/200')
  })

  it('drops non-string lsn values silently', () => {
    const states = buildTransactionStates([
      { ...xact(0, 'commit'), data: { xid: 1, vxid: 'v', state: 'commit', lsn: 123 as unknown as string } } as ProbeEvent,
    ])
    expect(states[0].lsn).toBeUndefined()
  })

  it('uses timestamp for start_time_us and end_time_us', () => {
    const states = buildTransactionStates([xact(5, 'begin', 3)])
    expect(states[0].start_time_us).toBe(ts(5))
    expect(states[0].end_time_us).toBe(ts(5))
  })
})

// ---------- buildWriteStages ----------

describe('buildWriteStages', () => {
  it('returns undefined when there are no relevant events', () => {
    expect(buildWriteStages([heartbeat(0, 'a')])).toBeUndefined()
  })

  it('marks exec_start as done when any of wal/buf/xact exists', () => {
    const stages = buildWriteStages([wal(0)])
    expect(stages).toBeDefined()
    const exec = stages!.find((s) => s.id === 'exec_start')!
    expect(exec.status).toBe('done')
    expect(exec.details).toEqual({ source: 'runtime event stream' })
  })

  it('fills wal_insert stage details from the latest wal event', () => {
    const stages = buildWriteStages([wal(0, { xlog_ptr: '0/AAA', rmgr_name: 'Btree', operation: 'INSERT_LEAF', xid: 99, record_len: 80, source: 'heap_insert' })])
    const walStage = stages!.find((s) => s.id === 'wal_insert')!
    expect(walStage.status).toBe('done')
    expect(walStage.details).toMatchObject({
      xlog_ptr: '0/AAA',
      rmgr_name: 'Btree',
      operation: 'INSERT_LEAF',
      xid: 99,
      record_len: 80,
      source: 'heap_insert',
    })
  })

  it('fills buf_alloc stage details from the latest buffer_pin event', () => {
    const stages = buildWriteStages([
      buf(0, { buffer_id: 42, relfilenode: 7777, block_num: 11 }),
    ])
    const bufStage = stages!.find((s) => s.id === 'buf_alloc')!
    expect(bufStage.status).toBe('done')
    expect(bufStage.details).toEqual({
      buffer_id: 42,
      relfilenode: 7777,
      block_num: 11,
    })
  })

  it('uses the latest of each event type when many are present', () => {
    const stages = buildWriteStages([
      wal(0, { xlog_ptr: '0/OLD', xid: 1 }),
      wal(1, { xlog_ptr: '0/NEW', xid: 2 }),
      buf(2, { buffer_id: 5 }),
      buf(3, { buffer_id: 99 }),
    ])
    const walStage = stages!.find((s) => s.id === 'wal_insert')!
    expect(walStage.details).toMatchObject({ xlog_ptr: '0/NEW', xid: 2 })
    const bufStage = stages!.find((s) => s.id === 'buf_alloc')!
    expect(bufStage.details).toMatchObject({ buffer_id: 99 })
  })

  it('marks clog_update + commit as done when the latest xact is commit', () => {
    const stages = buildWriteStages([xact(0, 'begin', 1), xact(1, 'commit', 1)])
    const clog = stages!.find((s) => s.id === 'clog_update')!
    const commit = stages!.find((s) => s.id === 'commit')!
    expect(clog.status).toBe('done')
    expect(commit.status).toBe('done')
    expect(commit.details).toMatchObject({ xid: 1, state: 'commit' })
  })

  it('marks clog_update + commit as error when the latest xact is abort', () => {
    const stages = buildWriteStages([xact(0, 'begin', 1), xact(1, 'abort', 1)])
    const clog = stages!.find((s) => s.id === 'clog_update')!
    const commit = stages!.find((s) => s.id === 'commit')!
    expect(clog.status).toBe('error')
    expect(commit.status).toBe('error')
    expect(commit.details).toMatchObject({ xid: 1, state: 'abort' })
    // abort does not surface lsn in details
    expect(commit.details).not.toHaveProperty('lsn')
  })

  it('leaves clog_update + commit pending when the latest xact is begin', () => {
    const stages = buildWriteStages([xact(0, 'begin', 1)])
    const clog = stages!.find((s) => s.id === 'clog_update')!
    const commit = stages!.find((s) => s.id === 'commit')!
    expect(clog.status).toBe('pending')
    expect(commit.status).toBe('pending')
  })

  it('keeps the template length and order intact', () => {
    const stages = buildWriteStages([wal(0)])
    expect(stages).toBeDefined()
    expect(stages!.map((s) => s.id)).toEqual([
      'parse',
      'bind',
      'plan',
      'exec_start',
      'tuple_form',
      'buf_alloc',
      'wal_insert',
      'page_modify',
      'clog_update',
      'commit',
    ])
  })
})