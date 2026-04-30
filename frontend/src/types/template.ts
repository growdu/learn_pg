import type { ClusterNodeConfig } from './cluster'
import type { WorkspaceProject, WorkspaceComponent, WorkspaceCluster } from './workspace'

export type ReplicationTemplate = 'physical' | 'logical'
export type ClusterNodeRole = 'primary' | 'standby' | 'publisher' | 'subscriber'

export interface TemplateNode {
  name: string
  role: ClusterNodeRole
}

export interface TemplateCluster {
  name: string
  replicationType: ReplicationTemplate
  nodes: TemplateNode[]
}

export interface TemplateComponent {
  name: string
  componentType: WorkspaceComponent['componentType']
  linkedClusterName: string
}

export interface TemplateParams {
  nodeCount: number
  alertThresholdSec: number
}

export interface WorkspaceTemplate {
  id: ReplicationTemplate
  name: string
  description: string
  /** ASCII topology preview */
  preview: string
  defaultParams: TemplateParams
  buildProject: (name: string, params: TemplateParams, makeNode: (idx: number, role: ClusterNodeRole) => ClusterNodeConfig) => WorkspaceProject
}

const genId = () => crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)

export const PHYSICAL_TEMPLATE: WorkspaceTemplate = {
  id: 'physical',
  name: '物理复制模板',
  description: '一主多从流复制架构，包含 WAL 采集、复制延迟监控。支持新增 standby 节点、故障切换观测。',
  preview: `┌──────────────────────────────────────────────┐
│          物理复制（流复制）                         │
│                                                 │
│   ┌── primary (R/W) ─── WAL streaming ──► standby1  │
│   │                                        (R/O)   │
│   │                                        ↓        │
│   └───► standby2 (R/O)      ◄── WAL streaming ─┘   │
│                                                 │
│   [collector component]                         │
└──────────────────────────────────────────────┘`,
  defaultParams: { nodeCount: 2, alertThresholdSec: 30 },
  buildProject: (name, { nodeCount }, makeNode) => {
    const nodes: ClusterNodeConfig[] = Array.from({ length: nodeCount }, (_, i) =>
      makeNode(i + 1, i === 0 ? 'primary' : 'standby'),
    )
    const cluster: WorkspaceCluster = {
      id: genId(),
      name: '主从集群',
      replicationType: 'physical',
      nodes,
    }
    const component: WorkspaceComponent = {
      id: genId(),
      name: '物理复制采集组件',
      componentType: 'collector',
      linkedClusterIds: [cluster.id],
    }
    return { id: genId(), name, clusters: [cluster], components: [component] }
  },
}

export const LOGICAL_TEMPLATE: WorkspaceTemplate = {
  id: 'logical',
  name: '逻辑复制模板',
  description: '发布/订阅逻辑复制架构，支持跨集群数据同步、CDC 场景观测。publisher 输出 WAL，subscriber 消费逻辑日志。',
  preview: `┌──────────────────────────────────────────────┐
│         逻辑复制（发布 / 订阅）                      │
│                                                 │
│   ┌── publisher ──► replication slot ──► subscriber │
│   │   (pg_dump/copy)              (apply)          │
│   │                                                 │
│   │   WAL  ──► logical decoding ──► SQL apply      │
│   │                                                 │
│   [logical collector]    [logical subscriber]     │
└──────────────────────────────────────────────┘`,
  defaultParams: { nodeCount: 2, alertThresholdSec: 60 },
  buildProject: (name, { nodeCount }, makeNode) => {
    const nodes: ClusterNodeConfig[] = Array.from({ length: nodeCount }, (_, i) =>
      makeNode(i + 1, i === 0 ? 'publisher' : 'subscriber'),
    )
    const cluster: WorkspaceCluster = {
      id: genId(),
      name: '发布订阅集群',
      replicationType: 'logical',
      nodes,
    }
    const component: WorkspaceComponent = {
      id: genId(),
      name: '逻辑复制采集组件',
      componentType: 'collector',
      linkedClusterIds: [cluster.id],
    }
    return { id: genId(), name, clusters: [cluster], components: [component] }
  },
}

export const ALL_TEMPLATES: WorkspaceTemplate[] = [PHYSICAL_TEMPLATE, LOGICAL_TEMPLATE]
