import { useEffect, useMemo, useState } from 'react'
import Header from './components/layout/Header'
import StatusBar from './components/layout/StatusBar'
import SQLConsole from './components/sql/SQLConsole'
import NodeHomeView from './components/node/NodeHomeView'
import WALViewer from './components/wal/WALViewer'
import CLOGViewer from './components/clog/CLOGViewer'
import PipelineView from './components/pipeline/PipelineView'
import BufferHeatmapView from './components/buffer/BufferHeatmapView'
import LockGraphView from './components/lock/LockGraphView'
import ToastNotification from './components/common/ToastNotification'
import MemoryStructView from './components/memory/MemoryStructView'
import PlanTreeView from './components/pipeline/PlanTreeView'
import TransactionStateView, { type TransactionState } from './components/transaction/TransactionStateView'
import ProjectHomeView from './components/workspace/ProjectHomeView'
import ClusterHomeView from './components/workspace/ClusterHomeView'
import ComponentHomeView from './components/workspace/ComponentHomeView'
import TemplateDialog from './components/workspace/TemplateDialog'
import { useVisualizationData } from './hooks/useVisualizationData'
import { useWebSocket } from './hooks/useWebSocket'
import { usePGStore } from './stores/pgStore'
import type { ClusterNodeConfig } from './types/cluster'
import type { WorkspaceComponent, WorkspaceProject } from './types/workspace'
import type { ReplicationTemplate, TemplateParams } from './types/template'
import { ALL_TEMPLATES } from './types/template'
import type { TemplateCreateMode } from './components/workspace/TemplateDialog'
import type { LockEdge, LockNode } from './components/lock/LockGraphView'
import './styles/index.css'

export type View =
  | 'project_home'
  | 'cluster_home'
  | 'component_home'
  | 'node_home'
  | 'sql'
  | 'write'
  | 'read'
  | 'transaction'
  | 'xact_state'
  | 'wal'
  | 'clog'
  | 'buffer'
  | 'lock'
  | 'memory'
  | 'plan'

const TASK_STORAGE_KEY = 'pgv_provision_task'
const WORKSPACE_SCHEMA_VERSION = 1
const genId = () => crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)

function loadProvisionTaskCache(): { taskId: string; status: string; progress: number; message: string; startedAt?: number; finishedAt?: number; projectId?: string } | null {
  try {
    const raw = localStorage.getItem(TASK_STORAGE_KEY)
    if (!raw) return null
    const t = JSON.parse(raw) as { taskId?: string; status?: string; progress?: number; message?: string; startedAt?: number; finishedAt?: number; projectId?: string }
    if (!t.taskId || !t.status) return null
    return {
      taskId: t.taskId,
      status: t.status,
      progress: t.progress ?? 0,
      message: t.message ?? '',
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      projectId: t.projectId,
    }
  } catch {
    return null
  }
}

async function loadProjectsFromBackend(): Promise<WorkspaceProject[] | null> {
  try {
    const res = await fetch('/api/workspace/projects')
    if (!res.ok) return null
    const data = (await res.json()) as {
      success?: boolean
      schemaVersion?: number
      projects?: WorkspaceProject[]
    }
    if (!data.success || !Array.isArray(data.projects)) return null
    return migrateWorkspaceProjects(data.projects, data.schemaVersion ?? 0)
  } catch {
    return null
  }
}

async function saveProjectsToBackend(projects: WorkspaceProject[]): Promise<boolean> {
  try {
    const res = await fetch('/api/workspace/projects', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: WORKSPACE_SCHEMA_VERSION, projects }),
    })
    return res.ok
  } catch {
    return false
  }
}

async function provisionClusterByTemplate(
  templateId: ReplicationTemplate,
  projectId: string,
  clusterName: string,
): Promise<{ ok: boolean; taskId?: string; error?: string }> {
  const endpoint =
    templateId === 'single'
      ? '/api/provision/single'
      : templateId === 'physical'
        ? '/api/provision/physical'
        : '/api/provision/logical'
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        clusterName,
        runtime: { type: 'docker' },
      }),
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const data = (await res.json()) as { success?: boolean; taskId?: string }
    return { ok: !!data.success, taskId: data.taskId, error: data.success ? undefined : 'provision failed' }
  } catch {
    return { ok: false, error: 'network error' }
  }
}

async function getProvisionTask(taskId: string): Promise<{ status: string; progress: number; message?: string; startedAt?: number; finishedAt?: number } | null> {
  try {
    const res = await fetch(`/api/provision/tasks/${taskId}`)
    if (!res.ok) return null
    const data = (await res.json()) as {
      success?: boolean
      task?: { status?: string; progress?: number; message?: string; startedAt?: number; finishedAt?: number }
    }
    if (!data.success || !data.task) return null
    return {
      status: data.task.status || 'unknown',
      progress: data.task.progress ?? 0,
      message: data.task.message,
      startedAt: data.task.startedAt,
      finishedAt: data.task.finishedAt,
    }
  } catch {
    return null
  }
}

async function listProvisionTasks(
  limit = 10,
  status: 'all' | 'running' | 'success' | 'failed' = 'all',
): Promise<Array<{ taskId: string; status: string; progress: number; message?: string; startedAt?: number; finishedAt?: number; projectId?: string; clusterId?: string }>> {
  try {
    const res = await fetch(`/api/tasks?limit=${limit}&status=${status === 'all' ? '' : status}`)
    if (!res.ok) return []
    const data = await res.json()
    if (!data.success || !Array.isArray(data.tasks)) return []
    return data.tasks.map((t: { taskId?: string; status?: string; progress?: number; message?: string; startedAt?: number; finishedAt?: number; projectId?: string; clusterId?: string }) => ({
      taskId: t.taskId || '-',
      status: t.status || 'unknown',
      progress: t.progress ?? 0,
      message: t.message,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      projectId: t.projectId,
      clusterId: t.clusterId,
    }))
  } catch {
    return []
  }
}

function migrateWorkspaceProjects(projects: WorkspaceProject[], _schemaVersion: number): WorkspaceProject[] {
  return projects.map((p) => ({
    ...p,
    clusters: (p.clusters ?? []).map((c) => ({
      ...c,
      alertThresholdSec: c.alertThresholdSec && c.alertThresholdSec > 0 ? c.alertThresholdSec : 30,
      nodes: c.nodes ?? [],
    })),
    components: (p.components ?? []).map((m) => ({
      ...m,
      linkedClusterIds: m.linkedClusterIds ?? [],
    })),
  }))
}

function makeDefaultNode(idx: number, role: ClusterNodeConfig['role'] = idx === 1 ? 'primary' : 'standby'): ClusterNodeConfig {
  const cfg = usePGStore.getState().config
  return {
    id: genId(),
    name: `Node ${idx}`,
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    database: cfg.database,
    cluster_type: role === 'publisher' || role === 'subscriber' ? 'logical' : 'physical',
    role,
    source: 'manual',
  }
}

function App() {
  const [currentView, setCurrentView] = useState<View>('project_home')
  const [connected, setConnected] = useState(false)
  const [pgVersion, setPgVersion] = useState('')
  const [projects, setProjects] = useState<WorkspaceProject[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [selectedClusterId, setSelectedClusterId] = useState('')
  const [selectedNodeId, setSelectedNodeId] = useState('')
  const [showTemplateDialog, setShowTemplateDialog] = useState(false)
  const [highlightedComponentIds, setHighlightedComponentIds] = useState<string[]>([])
  const [workspaceBootstrapped, setWorkspaceBootstrapped] = useState(false)
  const [workspaceSyncError, setWorkspaceSyncError] = useState('')
  const [snapshotLocks, setSnapshotLocks] = useState<{ nodes: LockNode[]; edges: LockEdge[] }>({ nodes: [], edges: [] })
  const [snapshotTransactions, setSnapshotTransactions] = useState<TransactionState[]>([])
  const [snapshotBackends, setSnapshotBackends] = useState<Array<Record<string, string>>>([])
  const [provisionTask, setProvisionTask] = useState<{ taskId: string; status: string; progress: number; message: string; startedAt?: number; finishedAt?: number; projectId?: string } | null>(() => loadProvisionTaskCache())
  const [recentTasks, setRecentTasks] = useState<Array<{ taskId: string; status: string; progress: number; message?: string; startedAt?: number; finishedAt?: number; projectId?: string; clusterId?: string }>>([])
  const [showRecentTasks, setShowRecentTasks] = useState(false)
  const [recentTaskFilter, setRecentTaskFilter] = useState<'all' | 'running' | 'success' | 'failed'>('all')

  const storeConnected = usePGStore((s) => s.connected)
  const storeVersion = usePGStore((s) => s.version)
  const storeConfig = usePGStore((s) => s.config)
  const { connected: wsConnected } = useWebSocket()
  const { buffers, collectorMode, eventCount, lastEventType, transactions, writeStages } = useVisualizationData()

  useEffect(() => {
    if (storeConnected) setConnected(true)
    if (storeVersion) setPgVersion(storeVersion)
  }, [storeConnected, storeVersion])

  useEffect(() => {
    let stop = false
    ;(async () => {
      const remote = await loadProjectsFromBackend()
      if (stop) return
      if (remote) {
        setProjects(remote)
        setWorkspaceSyncError('')
        if (remote[0]) {
          setSelectedProjectId(remote[0].id)
          setSelectedClusterId(remote[0].clusters[0]?.id ?? '')
        }
      } else {
        setWorkspaceSyncError('工作区后端不可用，当前使用本地缓存。')
      }
      setWorkspaceBootstrapped(true)
    })()
    return () => {
      stop = true
    }
  }, [])

  const reloadWorkspaceFromBackend = async () => {
    const remote = await loadProjectsFromBackend()
    if (!remote) return false
    setProjects(remote)
    const currentProjectId = selectedProjectId || remote[0]?.id || ''
    setSelectedProjectId(currentProjectId)
    const p = remote.find((x) => x.id === currentProjectId) ?? remote[0]
    setSelectedClusterId(p?.clusters[0]?.id ?? '')
    return true
  }

  useEffect(() => {
    if (!workspaceBootstrapped) return
    const t = window.setTimeout(() => {
      void (async () => {
        const ok = await saveProjectsToBackend(projects)
        setWorkspaceSyncError(ok ? '' : '工作区保存失败，变更仅保存在本地缓存。')
      })()
    }, 250)
    return () => window.clearTimeout(t)
  }, [projects, workspaceBootstrapped])

  useEffect(() => {
    let stop = false

    const loadSnapshot = async () => {
      if (!connected) {
        if (!stop) {
          setSnapshotLocks({ nodes: [], edges: [] })
          setSnapshotTransactions([])
          setSnapshotBackends([])
        }
        return
      }
      try {
        const res = await fetch('/api/snapshot')
        if (!res.ok) return
        const data = (await res.json()) as {
          current_xid?: number
          backends?: Array<Record<string, string>>
          locks?: Array<Record<string, string>>
        }
        if (stop) return
        const { nodes, edges } = buildLockGraphFromSnapshot(data.backends ?? [], data.locks ?? [])
        setSnapshotLocks({ nodes, edges })
        setSnapshotTransactions(buildTransactionsFromSnapshot(data.backends ?? [], data.current_xid ?? 0))
        setSnapshotBackends(data.backends ?? [])
      } catch {
        // keep last successful snapshot
      }
    }

    void loadSnapshot()
    const timer = window.setInterval(loadSnapshot, 5000)
    return () => {
      stop = true
      window.clearInterval(timer)
    }
  }, [connected])

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? projects[0],
    [projects, selectedProjectId],
  )

  const selectedNodeConfig = useMemo(() => {
    if (!selectedProject) return null
    const cluster = selectedProject.clusters.find((c) => c.id === selectedClusterId)
    if (!cluster) return null
    return cluster.nodes.find((n) => n.id === selectedNodeId) ?? cluster.nodes[0] ?? null
  }, [selectedProject, selectedClusterId, selectedNodeId])

  useEffect(() => {
    if (!selectedProject) return
    if (!selectedProjectId) setSelectedProjectId(selectedProject.id)
    const cluster = selectedProject.clusters.find((c) => c.id === selectedClusterId) ?? selectedProject.clusters[0]
    if (cluster && cluster.id !== selectedClusterId) setSelectedClusterId(cluster.id)
    if (cluster && !selectedNodeId) {
      setSelectedNodeId(cluster.nodes[0]?.id ?? '')
    }
  }, [selectedProject, selectedProjectId, selectedClusterId])

  const createProject = () => {
    const idx = projects.length + 1
    const project: WorkspaceProject = { id: genId(), name: `项目 ${idx}`, clusters: [], components: [] }
    const next = [...projects, project]
    setProjects(next)
    setSelectedProjectId(project.id)
  }

  const handleTemplateConfirm = (templateId: ReplicationTemplate, name: string, params: TemplateParams, mode: TemplateCreateMode) => {
    setShowTemplateDialog(false)

    // Preview mode: build local template without API calls
    if (mode === 'preview') {
      const projectId = genId()
      const tpl = ALL_TEMPLATES.find((t) => t.id === templateId)!
      const previewProject = tpl.buildProject(name.trim() || `项目 ${projects.length + 1}`, params, makeDefaultNode)
      previewProject.id = projectId
      const previewProjects = [...projects, previewProject]
      setProjects(previewProjects)
      setSelectedProjectId(projectId)
      setSelectedClusterId(previewProject.clusters[0]?.id ?? '')
      setHighlightedComponentIds(previewProject.components.map((c) => c.id))
      setCurrentView('component_home')
      return
    }

    // Real create mode: call provision API
    void (async () => {
      const projectId = genId()
      const baseProject: WorkspaceProject = { id: projectId, name: name.trim() || `项目 ${projects.length + 1}`, clusters: [], components: [] }
      const optimistic = [...projects, baseProject]
      setProjects(optimistic)
      setSelectedProjectId(projectId)

      const seedOk = await saveProjectsToBackend(optimistic)
      const provision = seedOk ? await provisionClusterByTemplate(templateId, projectId, `${baseProject.name}-${templateId}`) : { ok: false as const }
      const provisionOk = provision.ok
      if (provision.taskId) {
        setProvisionTask({ taskId: provision.taskId, status: 'running', progress: 5, message: '集群创建中...', startedAt: Date.now(), projectId })
      } else if (!provisionOk) {
        // No fallback — failure is explicit failure
        setProvisionTask({
          taskId: `local-${Date.now()}`,
          status: 'failed',
          progress: 100,
          message: `集群创建失败：${provision.error || 'unknown error'}`,
          startedAt: Date.now(),
          finishedAt: Date.now(),
          projectId,
        })
        // Remove the optimistic project since provision failed
        setProjects((prev) => prev.filter((p) => p.id !== projectId))
        return
      }
      if (provisionOk) {
        const remote = await loadProjectsFromBackend()
        if (remote) {
          setProjects(remote)
          const current = remote.find((p) => p.id === projectId)
          setSelectedProjectId(projectId)
          setSelectedClusterId(current?.clusters[0]?.id ?? '')
          setHighlightedComponentIds([])
          setCurrentView('cluster_home')
          return
        }
      }
    })()
  }

  useEffect(() => {
    if (!provisionTask?.taskId) return
    if (provisionTask.status === 'success' || provisionTask.status === 'failed') return
    const timer = window.setInterval(() => {
      void (async () => {
        const task = await getProvisionTask(provisionTask.taskId)
        if (!task) return
        setProvisionTask((prev) =>
          prev
            ? {
                ...prev,
                status: task.status,
                progress: task.progress,
                message: task.message || prev.message,
                startedAt: task.startedAt || prev.startedAt,
                finishedAt: task.finishedAt,
              }
            : prev,
        )
      })()
    }, 1200)
    return () => window.clearInterval(timer)
  }, [provisionTask])

  const taskStatusLabel = (status: string) =>
    status === 'running' ? '进行中' : status === 'success' ? '成功' : status === 'failed' ? '失败' : status

  const taskDurationSec = (t: { startedAt?: number; finishedAt?: number }) =>
    t.startedAt ? Math.max(0, Math.floor(((t.finishedAt ?? Date.now()) - t.startedAt) / 1000)) : 0

  useEffect(() => {
    if (!provisionTask) return
    if (provisionTask.status !== 'success') return
    void reloadWorkspaceFromBackend()
    const t = window.setTimeout(() => setProvisionTask(null), 2200)
    return () => window.clearTimeout(t)
  }, [provisionTask])

  const refreshProvisionTask = async () => {
    if (!provisionTask?.taskId) return
    const task = await getProvisionTask(provisionTask.taskId)
    if (!task) return
    setProvisionTask((prev) =>
      prev
        ? {
            ...prev,
            status: task.status,
            progress: task.progress,
            message: task.message || prev.message,
            startedAt: task.startedAt || prev.startedAt,
            finishedAt: task.finishedAt,
          }
        : prev,
    )
  }

  const refreshRecentTasks = async () => {
    const items = await listProvisionTasks(8, recentTaskFilter)
    setRecentTasks(items)
  }

  useEffect(() => {
    void (async () => {
      const items = await listProvisionTasks(1)
      const latest = items[0]
      if (!latest) return
      if (latest.status === 'running') {
        setProvisionTask({
          taskId: latest.taskId,
          status: latest.status,
          progress: latest.progress,
          message: latest.message || '任务恢复中...',
          startedAt: latest.startedAt,
          finishedAt: latest.finishedAt,
        })
      }
    })()
  }, [])

  useEffect(() => {
    if (!showRecentTasks) return
    void refreshRecentTasks()
    const timer = window.setInterval(() => {
      void refreshRecentTasks()
    }, 3000)
    return () => window.clearInterval(timer)
  }, [showRecentTasks])

  useEffect(() => {
    if (!showRecentTasks) return
    void refreshRecentTasks()
  }, [recentTaskFilter])

  useEffect(() => {
    if (!provisionTask) {
      localStorage.removeItem(TASK_STORAGE_KEY)
      return
    }
    localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(provisionTask))
    if (provisionTask.status === 'failed') {
      setShowRecentTasks(true)
      setRecentTaskFilter('failed')
    }
  }, [provisionTask])

  const removeProject = (id: string) => {
    const next = projects.filter((p) => p.id !== id)
    setProjects(next)
    if (selectedProjectId === id) {
      setSelectedProjectId(next[0]?.id || '')
      setSelectedClusterId('')
    }
  }

  const updateProject = (projectId: string, patch: { name?: string }) => {
    const next = projects.map((p) => (p.id !== projectId ? p : { ...p, ...patch }))
    setProjects(next)
  }

  const createCluster = () => {
    if (!selectedProject) return
    const idx = selectedProject.clusters.length + 1
    const cluster = {
      id: genId(),
      name: `集群 ${idx}`,
      replicationType: 'physical' as const,
      alertThresholdSec: 30,
      nodes: [makeDefaultNode(1)],
    }
    const next = projects.map((p) => (p.id === selectedProject.id ? { ...p, clusters: [...p.clusters, cluster] } : p))
    setProjects(next)
    setSelectedClusterId(cluster.id)
  }

  const removeCluster = (id: string) => {
    if (!selectedProject) return
    const next = projects.map((p) => {
      if (p.id !== selectedProject.id) return p
      return { ...p, clusters: p.clusters.filter((c) => c.id !== id) }
    })
    setProjects(next)
    if (selectedClusterId === id) setSelectedClusterId('')
  }

  const updateClusterNode = (clusterId: string, nodeId: string, patch: Partial<ClusterNodeConfig & { name?: string; alertThresholdSec?: number }>) => {
    if (!selectedProject) return
    const next = projects.map((p) => {
      if (p.id !== selectedProject.id) return p
      return {
        ...p,
        clusters: p.clusters.map((c) => {
          if (c.id !== clusterId) return c
          if (!nodeId) {
            return { ...c, ...patch }
          }
          return { ...c, nodes: c.nodes.map((n) => (n.id !== nodeId ? n : { ...n, ...patch })) }
        }),
      }
    })
    setProjects(next)
  }

  const addNode = (clusterId: string) => {
    if (!selectedProject) return
    const next = projects.map((p) => {
      if (p.id !== selectedProject.id) return p
      return {
        ...p,
        clusters: p.clusters.map((c) => (c.id !== clusterId ? c : { ...c, nodes: [...c.nodes, makeDefaultNode(c.nodes.length + 1)] })),
      }
    })
    setProjects(next)
  }

  const removeNode = (clusterId: string, nodeId: string) => {
    if (!selectedProject) return
    const next = projects.map((p) => {
      if (p.id !== selectedProject.id) return p
      return {
        ...p,
        clusters: p.clusters.map((c) => {
          if (c.id !== clusterId) return c
          const filtered = c.nodes.filter((n) => n.id !== nodeId)
          return { ...c, nodes: filtered.length > 0 ? filtered : c.nodes }
        }),
      }
    })
    setProjects(next)
  }

  const createComponent = () => {
    if (!selectedProject) return
    const idx = selectedProject.components.length + 1
    const comp: WorkspaceComponent = { id: genId(), name: `组件 ${idx}`, componentType: 'collector', linkedClusterIds: [] }
    const next = projects.map((p) => (p.id === selectedProject.id ? { ...p, components: [...p.components, comp] } : p))
    setProjects(next)
  }

  const removeComponent = (id: string) => {
    if (!selectedProject) return
    const next = projects.map((p) => (p.id === selectedProject.id ? { ...p, components: p.components.filter((c) => c.id !== id) } : p))
    setProjects(next)
  }

  const updateComponent = (componentId: string, patch: { name?: string; componentType?: string }) => {
    if (!selectedProject) return
    const next = projects.map((p) => {
      if (p.id !== selectedProject.id) return p
      return { ...p, components: p.components.map((c) => (c.id !== componentId ? c : { ...c, ...patch } as WorkspaceComponent)) }
    })
    setProjects(next)
  }

  const toggleLink = (componentId: string, clusterId: string) => {
    if (!selectedProject) return
    const next = projects.map((p) => {
      if (p.id !== selectedProject.id) return p
      return {
        ...p,
        components: p.components.map((c) => {
          if (c.id !== componentId) return c
          const has = c.linkedClusterIds.includes(clusterId)
          return { ...c, linkedClusterIds: has ? c.linkedClusterIds.filter((x) => x !== clusterId) : [...c.linkedClusterIds, clusterId] }
        }),
      }
    })
    setProjects(next)
  }

  const renderView = () => {
    if (!['project_home', 'cluster_home', 'component_home'].includes(currentView) && !connected) {
      return (
        <div style={{ padding: '2rem' }}>
          <h2 style={{ marginTop: 0 }}>当前没有激活节点</h2>
          <p style={{ color: 'var(--text-muted)' }}>请先在集群主页激活节点，再进入节点观测模块。</p>
          <button onClick={() => setCurrentView('cluster_home')} style={{ padding: '0.5rem 0.9rem', border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--bg-secondary)', color: 'var(--text)', cursor: 'pointer' }}>
            返回集群主页
          </button>
        </div>
      )
    }

    switch (currentView) {
      case 'project_home':
        return (
          <ProjectHomeView
            projects={projects}
            selectedProjectId={selectedProjectId}
            onSelectProject={setSelectedProjectId}
            onCreateProject={createProject}
            onOpenTemplateDialog={() => setShowTemplateDialog(true)}
            onRemoveProject={removeProject}
            onUpdateProject={updateProject}
            onNavigateToCluster={(projectId, clusterId) => {
              setSelectedProjectId(projectId)
              setSelectedClusterId(clusterId)
              setCurrentView('cluster_home')
            }}
            onCreateCluster={(projectId) => {
              const project = projects.find((p) => p.id === projectId)
              if (!project) return
              const cluster = {
                id: genId(),
                name: `集群 ${project.clusters.length + 1}`,
                replicationType: 'physical' as const,
                alertThresholdSec: 30,
                nodes: [makeDefaultNode(1)],
              }
              const next = projects.map((p) => (p.id === projectId ? { ...p, clusters: [...p.clusters, cluster] } : p))
              setProjects(next)
              setSelectedProjectId(projectId)
              setSelectedClusterId(cluster.id)
              setCurrentView('cluster_home')
            }}
            onCreateComponent={(projectId) => {
              const project = projects.find((p) => p.id === projectId)
              if (!project) return
              const comp: WorkspaceComponent = { id: genId(), name: `组件 ${project.components.length + 1}`, componentType: 'collector', linkedClusterIds: [] }
              const next = projects.map((p) => (p.id === projectId ? { ...p, components: [...p.components, comp] } : p))
              setProjects(next)
            }}
          />
        )
      case 'cluster_home':
        return (
          <ClusterHomeView
            project={selectedProject}
            selectedClusterId={selectedClusterId}
            selectedNodeId={selectedNodeId}
            onSelectCluster={setSelectedClusterId}
            onCreateCluster={createCluster}
            onRemoveCluster={removeCluster}
            onUpdateClusterNode={updateClusterNode}
            onAddNode={addNode}
            onRemoveNode={removeNode}
            onNavigate={setCurrentView}
            onReloadWorkspace={reloadWorkspaceFromBackend}
            onActivateNode={(clusterId, nodeId) => {
              setSelectedClusterId(clusterId)
              setSelectedNodeId(nodeId)
            }}
            onNodeDoubleClick={(node) => {
              if (!selectedClusterId) return
              setSelectedNodeId(node.id)
              void (async () => {
                const res = await fetch('/api/connect', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ host: node.host, port: node.port, user: node.user, database: node.database }),
                })
                const data = await res.json()
                if (!data.success) return
                usePGStore.getState().setConfig({ host: node.host, port: node.port, user: node.user, database: node.database })
                usePGStore.getState().setConnected(true)
                usePGStore.getState().setVersion(data.version || '')
                setCurrentView('node_home')
              })()
            }}
          />
        )
      case 'component_home':
        return (
          <ComponentHomeView
            project={selectedProject}
            onCreateComponent={createComponent}
            onRemoveComponent={removeComponent}
            onUpdateComponent={updateComponent}
            onToggleLink={toggleLink}
            highlightedComponentIds={highlightedComponentIds}
            onActivateNode={(clusterId, nodeId) => {
              setSelectedClusterId(clusterId)
              setCurrentView('cluster_home')
              setTimeout(() => {
                const el = document.querySelector(`[data-node-id="${nodeId}"]`)
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
              }, 100)
            }}
          />
        )
      case 'node_home':
        return (
          <NodeHomeView
            onNavigate={setCurrentView}
            nodeLabel={nodeLabel}
            selectedNodeConfig={selectedNodeConfig ? { id: selectedNodeConfig.id, name: selectedNodeConfig.name, role: selectedNodeConfig.role, cluster_type: selectedNodeConfig.cluster_type } : null}
            nodeStatuses={[]}
            onUpdateNode={(nodeId, patch) => {
              if (!selectedClusterId) return
              updateClusterNode(selectedClusterId, nodeId, patch)
            }}
            onGoBack={() => setCurrentView('cluster_home')}
          />
        )
      case 'sql':
        return <SQLConsole onGoBack={() => setCurrentView('node_home')} />
      case 'wal':
        return <WALViewer onGoBack={() => setCurrentView('node_home')} />
      case 'clog':
        return <CLOGViewer onGoBack={() => setCurrentView('node_home')} />
      case 'write':
        return <PipelineView type="write" stages={writeStages} onGoBack={() => setCurrentView('node_home')} />
      case 'read':
        return <PipelineView type="read" onGoBack={() => setCurrentView('node_home')} />
      case 'transaction':
        return <PipelineView type="transaction" onGoBack={() => setCurrentView('node_home')} />
      case 'xact_state':
        return (
          <TransactionStateView
            transactions={snapshotTransactions.length > 0 ? snapshotTransactions : transactions.length > 0 ? transactions : undefined}
            onGoBack={() => setCurrentView('node_home')}
          />
        )
      case 'buffer':
        return <BufferHeatmapView buffers={buffers.length > 0 ? buffers : undefined} onGoBack={() => setCurrentView('node_home')} />
      case 'lock':
        return <LockGraphView nodes={snapshotLocks.nodes.length > 0 ? snapshotLocks.nodes : undefined} edges={snapshotLocks.edges.length > 0 ? snapshotLocks.edges : undefined} onGoBack={() => setCurrentView('node_home')} />
      case 'memory':
        return <MemoryStructView snapshotBackends={snapshotBackends} onGoBack={() => setCurrentView('node_home')} />
      case 'plan':
        return <PlanTreeView onGoBack={() => setCurrentView('node_home')} />
      default:
        return (
          <NodeHomeView
            onNavigate={setCurrentView}
            nodeLabel={nodeLabel}
            selectedNodeConfig={selectedNodeConfig ? { id: selectedNodeConfig.id, name: selectedNodeConfig.name, role: selectedNodeConfig.role, cluster_type: selectedNodeConfig.cluster_type } : null}
            nodeStatuses={[]}
            onUpdateNode={(nodeId, patch) => {
              if (!selectedClusterId) return
              updateClusterNode(selectedClusterId, nodeId, patch)
            }}
            onGoBack={() => setCurrentView('cluster_home')}
          />
        )
    }
  }

  const nodeLabel = `${storeConfig.host}:${storeConfig.port}/${storeConfig.database}`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Header connected={connected} pgVersion={pgVersion} wsConnected={wsConnected} />
      <main style={{ flex: 1, overflow: 'auto' }}>
        {provisionTask && (
            <div className={`task-bar ${provisionTask.status === 'failed' ? 'task-bar-failed' : provisionTask.status === 'success' ? 'task-bar-success' : 'task-bar-running'}`}>
              <div className="task-bar-info">
                任务 {provisionTask.taskId} · {taskStatusLabel(provisionTask.status)} · {provisionTask.progress}% · {provisionTask.message}
              </div>
              <div className="task-bar-meta">
                <span>
                  {provisionTask.startedAt
                    ? `耗时 ${Math.max(0, Math.floor(((provisionTask.finishedAt ?? Date.now()) - provisionTask.startedAt) / 1000))}s`
                    : ''}
                </span>
                <div className="task-bar-actions">
                  <button className="task-btn" onClick={() => void refreshProvisionTask()}>
                    刷新
                  </button>
                  <button className="task-btn" onClick={() => setShowRecentTasks((v) => !v)}>
                    最近任务
                  </button>
                  <button className="task-btn" onClick={() => setProvisionTask(null)}>
                    关闭
                  </button>
                </div>
              </div>
              <div className="progress-track" style={{ marginTop: '0.25rem' }}>
                <div className="progress-fill" style={{ width: `${Math.max(0, Math.min(100, provisionTask.progress))}%` }} />
              </div>
              {showRecentTasks && (
                <div style={{ marginTop: '0.45rem', borderTop: '1px dashed var(--border)', paddingTop: '0.35rem' }}>
                  <div style={{ marginBottom: '0.35rem', display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                    <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)' }}>筛选</span>
                    <select
                      className="task-select"
                      value={recentTaskFilter}
                      onChange={(e) => setRecentTaskFilter(e.target.value as 'all' | 'running' | 'success' | 'failed')}
                    >
                      <option value="all">全部</option>
                      <option value="running">进行中</option>
                      <option value="success">成功</option>
                      <option value="failed">失败</option>
                    </select>
                  </div>
                  {recentTasks.length === 0 && <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)' }}>暂无历史任务</div>}
                  {recentTasks.map((t) => (
                    <div
                      key={t.taskId}
                      className={`task-item ${t.status === 'failed' ? 'task-item-failed' : ''}`}
                    >
                      <div>{t.taskId} · {taskStatusLabel(t.status)} · {t.progress}%</div>
                      <div style={{ marginTop: '0.12rem' }}>{t.message || '-'}</div>
                      <div style={{ marginTop: '0.12rem' }}>
                        耗时: {taskDurationSec(t)}s
                        {t.projectId ? ` · 项目: ${t.projectId}` : ''}
                        {t.clusterId ? ` · 集群: ${t.clusterId}` : ''}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {workspaceSyncError && (
            <div className="warning-banner">
              {workspaceSyncError}
            </div>
          )}
          <div className="breadcrumb">
            {['project_home', 'cluster_home', 'component_home'].includes(currentView)
              ? selectedProject
                ? `项目工作区 / ${selectedProject.name}${currentView === 'cluster_home' ? ` / 集群 ${selectedProject.clusters.find((c) => c.id === selectedClusterId)?.name ?? ''}` : ''}`
                : '项目工作区 / 未选择项目'
              : `节点工作区 / ${selectedNodeConfig ? `${selectedNodeConfig.name} (${selectedNodeConfig.role})` : nodeLabel}`}
          </div>
          {renderView()}
        <button
          className="task-panel-toggle"
          onClick={() => setShowRecentTasks(!showRecentTasks)}
          style={{
            position: 'fixed',
            right: '1rem',
            top: '4rem',
            zIndex: 99,
            padding: '0.5rem 0.9rem',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: '6px',
            color: 'var(--text)',
            cursor: 'pointer',
          }}
        >
          任务 {recentTasks.filter(t => t.status === 'running').length > 0 && `(${recentTasks.filter(t => t.status === 'running').length})`}
        </button>
        </main>
      <StatusBar collectorMode={collectorMode} connected={connected} eventCount={eventCount} lastEventType={lastEventType} wsConnected={wsConnected} />
      {showTemplateDialog && (
        <TemplateDialog
          onConfirm={handleTemplateConfirm}
          onCancel={() => setShowTemplateDialog(false)}
        />
      )}
      <ToastNotification
        task={provisionTask}
        onDismiss={() => setProvisionTask(null)}
      />
    </div>
  )
}

export default App

function buildLockGraphFromSnapshot(
  backends: Array<Record<string, string>>,
  locks: Array<Record<string, string>>,
): { nodes: LockNode[]; edges: LockEdge[] } {
  const nodes: LockNode[] = []
  const edges: LockEdge[] = []

  const backendByPID = new Map<string, LockNode>()
  for (const b of backends) {
    const pid = Number(b.pid ?? 0)
    const id = `pid-${pid}`
    const node: LockNode = {
      id,
      pid,
      label: `PID ${pid}`,
      type: 'backend',
    }
    nodes.push(node)
    backendByPID.set(String(pid), node)
  }

  const lockNodeByKey = new Map<string, LockNode>()
  for (const l of locks) {
    const lockKey = [
      l.locktype ?? '',
      l.relation ?? '',
      l.virtualxid ?? '',
      l.transactionid ?? '',
      l.mode ?? '',
    ].join('|')
    if (!lockNodeByKey.has(lockKey)) {
      const ln: LockNode = {
        id: `lock-${lockNodeByKey.size + 1}`,
        pid: 0,
        label: `${l.locktype ?? 'lock'}:${l.relation || l.transactionid || l.virtualxid || '-'}`,
        type: 'lock',
      }
      lockNodeByKey.set(lockKey, ln)
      nodes.push(ln)
    }

    const pid = String(l.pid ?? '')
    const backendNode = backendByPID.get(pid)
    const lockNode = lockNodeByKey.get(lockKey)
    if (!backendNode || !lockNode) continue

    edges.push({
      source: backendNode.id,
      target: lockNode.id,
      wait_time_us: l.granted === 'false' ? 100000 : 0,
      mode: l.mode ?? 'unknown',
    })
  }

  return { nodes, edges }
}

function buildTransactionsFromSnapshot(
  backends: Array<Record<string, string>>,
  currentXid: number,
): TransactionState[] {
  return backends
    .map((b) => {
      const xid = Number(b.backend_xid ?? 0) || currentXid || 0
      const stateText = (b.state ?? '').toLowerCase()
      const mapped: TransactionState['state'] =
        stateText.includes('idle') ? 'idle' :
          stateText.includes('active') ? 'in_progress' :
            'started'
      return {
        xid,
        vxid: b.backend_xmin ?? '',
        state: mapped,
      }
    })
    .filter((t) => t.xid > 0)
}
