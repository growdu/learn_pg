import type { ClusterNodeConfig } from './cluster'

export interface WorkspaceProject {
  id: string
  name: string
  clusters: WorkspaceCluster[]
  components: WorkspaceComponent[]
}

export interface WorkspaceCluster {
  id: string
  name: string
  replicationType: 'physical' | 'logical'
  alertThresholdSec?: number
  nodes: ClusterNodeConfig[]
}

export interface WorkspaceNode {
  connectionStatus?: 'unknown' | 'connecting' | 'ready' | 'failed'
  hostId?: string
  lastError?: string
}

export interface WorkspaceComponent {
  id: string
  name: string
  componentType: 'collector' | 'analyzer' | 'storage' | 'custom'
  linkedClusterIds: string[]
}
