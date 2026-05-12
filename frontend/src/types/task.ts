export type TaskType = 'provision.single' | 'provision.physical' | 'provision.logical' | 'discovery.scan' | 'discovery.import'

export type TaskStatus = 'pending' | 'running' | 'success' | 'failed'

export interface Task {
  taskId: string
  taskType: TaskType
  status: TaskStatus
  progress: number
  message?: string
  result?: string
  logs?: string
  projectId?: string
  clusterId?: string
  nodeIds?: string[]
  error?: string
  startedAt?: number
  finishedAt?: number
}
