export type ClusterType = 'physical' | 'logical'

export interface ClusterNodeConfig {
  id: string
  name: string
  host: string
  port: number
  user: string
  password: string
  database: string
  cluster_type: ClusterType
  role: string
}

export interface ReplicationChannel {
  name: string
  state: string
  sync_state: string
  sent_lsn?: string
  write_lsn?: string
  flush_lsn?: string
  replay_lsn?: string
  lag_bytes?: number
}

export interface LogicalSubscription {
  name: string
  enabled: boolean
  worker_type?: string
  received_lsn?: string
  latest_end_lsn?: string
  latest_end_time?: string
}

export interface ClusterNodeStatus {
  id: string
  name: string
  host: string
  port: number
  database: string
  cluster_type: ClusterType
  role: string
  connected: boolean
  error?: string
  version?: string
  in_recovery: boolean
  current_lsn?: string
  replay_lsn?: string
  wal_receiver_status?: string
  physical_replication?: ReplicationChannel[]
  logical_slots: number
  publications: number
  subscriptions?: LogicalSubscription[]
}

export interface ClusterOverviewResponse {
  success: boolean
  timestamp: number
  nodes: ClusterNodeStatus[]
  summary: {
    total_nodes: number
    connected_nodes: number
    physical_nodes: number
    logical_nodes: number
  }
  error?: string
}
