import type { ClusterNodeConfig } from './cluster'
import type { WorkspaceProject, WorkspaceComponent, WorkspaceCluster } from './workspace'

export type ReplicationTemplate = 'single' | 'physical' | 'logical'
export type ClusterNodeRole = 'primary' | 'standby' | 'publisher' | 'subscriber'

export interface TemplateParams {
  nodeCount: number
  alertThresholdSec: number
  createCollector: boolean
  createAnalyzer: boolean
  createStorage: boolean
  componentNamePattern: string
}

export interface WorkspaceTemplate {
  id: ReplicationTemplate
  name: string
  description: string
  preview: string
  defaultParams: TemplateParams
  buildProject: (name: string, params: TemplateParams, makeNode: (idx: number, role: ClusterNodeRole) => ClusterNodeConfig) => WorkspaceProject
}

const genId = () => crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)

function resolveComponentName(
  pattern: string,
  projectName: string,
  type: WorkspaceComponent['componentType'],
  fallback: string,
): string {
  const p = pattern.replace(/{project}/g, projectName).replace(/{type}/g, type).trim()
  return p.length > 0 ? p : fallback
}

function buildComponents(
  template: ReplicationTemplate,
  projectName: string,
  clusterId: string,
  params: TemplateParams,
): WorkspaceComponent[] {
  const out: WorkspaceComponent[] = []
  if (params.createCollector) {
    const fallback = template === 'logical' ? '逻辑复制采集组件' : '物理复制采集组件'
    out.push({
      id: genId(),
      name: resolveComponentName(params.componentNamePattern, projectName, 'collector', fallback),
      componentType: 'collector',
      linkedClusterIds: [clusterId],
    })
  }
  if (params.createAnalyzer) {
    const fallback = template === 'logical' ? 'CDC 分析组件' : '复制分析组件'
    out.push({
      id: genId(),
      name: resolveComponentName(params.componentNamePattern, projectName, 'analyzer', fallback),
      componentType: 'analyzer',
      linkedClusterIds: [clusterId],
    })
  }
  if (params.createStorage) {
    const fallback = template === 'logical' ? '变更存储组件' : '归档存储组件'
    out.push({
      id: genId(),
      name: resolveComponentName(params.componentNamePattern, projectName, 'storage', fallback),
      componentType: 'storage',
      linkedClusterIds: [clusterId],
    })
  }
  return out
}

export const PHYSICAL_TEMPLATE: WorkspaceTemplate = {
  id: 'physical',
  name: '物理复制模板',
  description: '一主多从流复制架构，支持 WAL 采集与复制延迟观测。',
  preview: `primary --> standby1\nprimary --> standby2`,
  defaultParams: {
    nodeCount: 2,
    alertThresholdSec: 30,
    createCollector: true,
    createAnalyzer: true,
    createStorage: false,
    componentNamePattern: '{project}-{type}',
  },
  buildProject: (name, params, makeNode) => {
    const nodes: ClusterNodeConfig[] = Array.from({ length: params.nodeCount }, (_, i) =>
      makeNode(i + 1, i === 0 ? 'primary' : 'standby'),
    )
    const cluster: WorkspaceCluster = {
      id: genId(),
      name: '主从集群',
      replicationType: 'physical',
      alertThresholdSec: params.alertThresholdSec,
      nodes,
    }
    return {
      id: genId(),
      name,
      clusters: [cluster],
      components: buildComponents('physical', name, cluster.id, params),
    }
  },
}

export const SINGLE_TEMPLATE: WorkspaceTemplate = {
  id: 'single',
  name: '单机模板',
  description: '单节点 PostgreSQL，适合快速启动与本地观测。',
  preview: `single(primary)`,
  defaultParams: {
    nodeCount: 1,
    alertThresholdSec: 30,
    createCollector: true,
    createAnalyzer: false,
    createStorage: false,
    componentNamePattern: '{project}-{type}',
  },
  buildProject: (name, params, makeNode) => {
    const nodes: ClusterNodeConfig[] = [makeNode(1, 'primary')]
    const cluster: WorkspaceCluster = {
      id: genId(),
      name: '单机集群',
      replicationType: 'physical',
      alertThresholdSec: params.alertThresholdSec,
      nodes,
    }
    return {
      id: genId(),
      name,
      clusters: [cluster],
      components: buildComponents('single', name, cluster.id, params),
    }
  },
}

export const LOGICAL_TEMPLATE: WorkspaceTemplate = {
  id: 'logical',
  name: '逻辑复制模板',
  description: '发布/订阅逻辑复制架构，支持 CDC 场景观测。',
  preview: `publisher --> subscriber`,
  defaultParams: {
    nodeCount: 2,
    alertThresholdSec: 60,
    createCollector: true,
    createAnalyzer: true,
    createStorage: true,
    componentNamePattern: '{project}-{type}',
  },
  buildProject: (name, params, makeNode) => {
    const nodes: ClusterNodeConfig[] = Array.from({ length: params.nodeCount }, (_, i) =>
      makeNode(i + 1, i === 0 ? 'publisher' : 'subscriber'),
    )
    const cluster: WorkspaceCluster = {
      id: genId(),
      name: '发布订阅集群',
      replicationType: 'logical',
      alertThresholdSec: params.alertThresholdSec,
      nodes,
    }
    return {
      id: genId(),
      name,
      clusters: [cluster],
      components: buildComponents('logical', name, cluster.id, params),
    }
  },
}

export const ALL_TEMPLATES: WorkspaceTemplate[] = [SINGLE_TEMPLATE, PHYSICAL_TEMPLATE, LOGICAL_TEMPLATE]
