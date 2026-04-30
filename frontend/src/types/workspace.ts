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
  nodes: ClusterNodeConfig[]
}

export interface WorkspaceComponent {
  id: string
  name: string
  componentType: 'collector' | 'analyzer' | 'storage' | 'custom'
  linkedClusterIds: string[]
}
