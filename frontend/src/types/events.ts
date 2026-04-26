export interface ProbeEvent {
  type: string
  timestamp: number
  pid: number
  seq: number
  data: Record<string, unknown>
}

export interface HeartbeatEvent extends ProbeEvent {
  type: 'heartbeat'
  data: {
    mode?: string
    probes?: unknown
    note?: string
  }
}

export interface WALInsertEvent extends ProbeEvent {
  type: 'wal_insert'
  data: {
    xlog_ptr: string
    lsn_value?: number
    record_len: number
    payload_len?: number
    rmgr_id: number
    rmgr_name: string
    operation?: string
    info: number
    xid: number
    block_num?: number
    rel_oid?: number
    source?: string
  }
}

export interface BufferPinEvent extends ProbeEvent {
  type: 'buffer_pin'
  data: {
    buffer_id: number
    is_hit: boolean
    relfilenode: number
    fork_num: number
    block_num: number
  }
}

export interface XactEvent extends ProbeEvent {
  type: 'xact_state'
  data: {
    xid: number
    vxid: string
    state: 'begin' | 'commit' | 'abort' | 'savepoint' | 'release' | 'rollback_to'
    savepoint_name?: string
    lsn?: string
  }
}

export interface LockWaitEvent extends ProbeEvent {
  type: 'lock_wait'
  data: {
    locktag_hash: string
    mode: string
    pid: number
    wait_time_us: number
  }
}

export interface LockEvent extends ProbeEvent {
  type: 'lock'
  data: {
    xid: number
    mode: string
    granted: boolean
    locktag: string
  }
}
