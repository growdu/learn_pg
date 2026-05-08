import { useEffect, useMemo, useState } from 'react'
import Header from './components/layout/Header'
import Sidebar from './components/layout/Sidebar'
import StatusBar from './components/layout/StatusBar'
import SQLConsole from './components/sql/SQLConsole'
import NodeHomeView from './components/node/NodeHomeView'
import WALViewer from './components/wal/WALViewer'
import CLOGViewer from './components/clog/CLOGViewer'
import PipelineView from './components/pipeline/PipelineView'
import BufferHeatmapView from './components/buffer/BufferHeatmapView'
import LockGraphView from './components/lock/LockGraphView'
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
import type { LockEdge, LockNode } from './components/lock/LockGraphView'

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

const STORAGE_KEY = 'pgv_workspace_projects'
const TASK_STORAGE_KEY = 'pgv_provision_task'
const WORKSPACE_SCHEMA_VERSION = 1
const genId = () => crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)

function loadProjects(): WorkspaceProject[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as WorkspaceProject[]
    return Array.isArray(parsed) ? migrateWorkspaceProjects(parsed, 0) : []
  } catch {
    return []
  }
}

function saveProjects(projects: WorkspaceProject[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projects))
}

function loadProvisionTaskCache(): { taskId: string; status: string; progress: number; message: string; startedAt?: number; finishedAt?: number } | null {
  try {
    const raw = localStorage.getItem(TASK_STORAGE_KEY)
    if (!raw) return null
    const t = JSON.parse(raw) as { taskId?: string; status?: string; progress?: number; message?: string; startedAt?: number; finishedAt?: number }
    if (!t.taskId || !t.status) return null
    return {
      taskId: t.taskId,
      status: t.status,
      progress: t.progress ?? 0,
      message: t.message ?? '',
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
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
        runtime: { type: 'local' },
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
    const res = await fetch(`/api/provision/tasks?limit=${limit}&status=${status}`)
    if (!res.ok) return []
    const data = (await res.json()) as {
      success?: boolean
      tasks?: Array<{ taskId?: string; status?: string; progress?: number; message?: string; startedAt?: number; finishedAt?: number; projectId?: string; clusterId?: string }>
    }
    if (!data.success || !Array.isArray(data.tasks)) return []
    return data.tasks.map((t) => ({
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
    password: cfg.password,
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
  const [projects, setProjects] = useState<WorkspaceProject[]>(() => loadProjects())
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [selectedClusterId, setSelectedClusterId] = useState('')
  const [showTemplateDialog, setShowTemplateDialog] = useState(false)
  const [highlightedComponentIds, setHighlightedComponentIds] = useState<string[]>([])
  const [workspaceBootstrapped, setWorkspaceBootstrapped] = useState(false)
  const [workspaceSyncError, setWorkspaceSyncError] = useState('')
  const [snapshotLocks, setSnapshotLocks] = useState<{ nodes: LockNode[]; edges: LockEdge[] }>({ nodes: [], edges: [] })
  const [snapshotTransactions, setSnapshotTransactions] = useState<TransactionState[]>([])
  const [snapshotBackends, setSnapshotBackends] = useState<Array<Record<string, string>>>([])
  const [provisionTask, setProvisionTask] = useState<{ taskId: string; status: string; progress: number; message: string; startedAt?: number; finishedAt?: number } | null>(() => loadProvisionTaskCache())
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
    saveProjects(projects)
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

  useEffect(() => {
    if (!selectedProject) return
    if (!selectedProjectId) setSelectedProjectId(selectedProject.id)
    const cluster = selectedProject.clusters.find((c) => c.id === selectedClusterId) ?? selectedProject.clusters[0]
    if (cluster && cluster.id !== selectedClusterId) setSelectedClusterId(cluster.id)
  }, [selectedProject, selectedProjectId, selectedClusterId])

  const createProject = () => {
    const idx = projects.length + 1
    const project: WorkspaceProject = { id: genId(), name: `项目 ${idx}`, clusters: [], components: [] }
    const next = [...projects, project]
    setProjects(next)
    setSelectedProjectId(project.id)
  }

  const handleTemplateConfirm = (templateId: ReplicationTemplate, name: string, params: TemplateParams) => {
    setShowTemplateDialog(false)
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
        setProvisionTask({ taskId: provision.taskId, status: 'running', progress: 5, message: '集群创建中...', startedAt: Date.now() })
      } else if (!provisionOk) {
        setProvisionTask({
          taskId: `local-${Date.now()}`,
          status: 'failed',
          progress: 100,
          message: `后端创建失败，已回退本地模板：${provision.error || 'unknown error'}`,
          startedAt: Date.now(),
          finishedAt: Date.now(),
        })
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

      // Fallback: keep local template creation when backend provision is unavailable.
      const tpl = ALL_TEMPLATES.find((t) => t.id === templateId)!
      const fallbackProject = tpl.buildProject(baseProject.name, params, makeDefaultNode)
      fallbackProject.id = projectId
      const fallbackProjects = projects.filter((p) => p.id !== projectId).concat(fallbackProject)
      setProjects(fallbackProjects)
      setSelectedProjectId(projectId)
      setSelectedClusterId(fallbackProject.clusters[0]?.id ?? '')
      setHighlightedComponentIds(fallbackProject.components.map((c) => c.id))
      setCurrentView('component_home')
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

  const updateClusterNode = (clusterId: string, nodeId: string, patch: Partial<ClusterNodeConfig>) => {
    if (!selectedProject) return
    const next = projects.map((p) => {
      if (p.id !== selectedProject.id) return p
      return {
        ...p,
        clusters: p.clusters.map((c) => (c.id !== clusterId ? c : { ...c, nodes: c.nodes.map((n) => (n.id !== nodeId ? n : { ...n, ...patch })) })),
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
          />
        )
      case 'cluster_home':
        return (
          <ClusterHomeView
            project={selectedProject}
            selectedClusterId={selectedClusterId}
            onSelectCluster={setSelectedClusterId}
            onCreateCluster={createCluster}
            onRemoveCluster={removeCluster}
            onUpdateClusterNode={updateClusterNode}
            onAddNode={addNode}
            onRemoveNode={removeNode}
            onNavigate={setCurrentView}
            onReloadWorkspace={reloadWorkspaceFromBackend}
          />
        )
      case 'component_home':
        return (
          <ComponentHomeView
            project={selectedProject}
            onCreateComponent={createComponent}
            onRemoveComponent={removeComponent}
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
        return <NodeHomeView onNavigate={setCurrentView} nodeLabel={nodeLabel} />
      case 'sql':
        return <SQLConsole />
      case 'wal':
        return <WALViewer />
      case 'clog':
        return <CLOGViewer />
      case 'write':
        return <PipelineView type="write" stages={writeStages} />
      case 'read':
        return <PipelineView type="read" />
      case 'transaction':
        return <PipelineView type="transaction" />
      case 'xact_state':
        return (
          <TransactionStateView
            transactions={snapshotTransactions.length > 0 ? snapshotTransactions : transactions.length > 0 ? transactions : undefined}
          />
        )
      case 'buffer':
        return <BufferHeatmapView buffers={buffers.length > 0 ? buffers : undefined} />
      case 'lock':
        return <LockGraphView nodes={snapshotLocks.nodes.length > 0 ? snapshotLocks.nodes : undefined} edges={snapshotLocks.edges.length > 0 ? snapshotLocks.edges : undefined} />
      case 'memory':
        return <MemoryStructView snapshotBackends={snapshotBackends} />
      case 'plan':
        return <PlanTreeView />
      default:
        return <NodeHomeView onNavigate={setCurrentView} nodeLabel={nodeLabel} />
    }
  }

  const nodeActive = connected
  const projectActive = !!selectedProject
  const nodeLabel = `${storeConfig.host}:${storeConfig.port}/${storeConfig.database}`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Header connected={connected} pgVersion={pgVersion} wsConnected={wsConnected} />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <Sidebar currentView={currentView} onNavigate={setCurrentView} projectActive={projectActive} nodeActive={nodeActive} nodeLabel={nodeLabel} />
        <main style={{ flex: 1, overflow: 'auto', padding: '0' }}>
          {provisionTask && (
            <div
              style={{
                padding: '0.45rem 1rem',
                borderBottom: '1px solid var(--border)',
                background:
                  provisionTask.status === 'failed'
                    ? 'rgba(239,68,68,0.15)'
                    : provisionTask.status === 'success'
                      ? 'rgba(34,197,94,0.15)'
                      : 'rgba(59,130,246,0.12)',
              }}
            >
              <div style={{ fontSize: '0.78rem', color: 'var(--text)' }}>
                任务 {provisionTask.taskId} · {taskStatusLabel(provisionTask.status)} · {provisionTask.progress}% · {provisionTask.message}
              </div>
              <div style={{ marginTop: '0.2rem', fontSize: '0.74rem', color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>
                  {provisionTask.startedAt
                    ? `耗时 ${Math.max(0, Math.floor(((provisionTask.finishedAt ?? Date.now()) - provisionTask.startedAt) / 1000))}s`
                    : ''}
                </span>
                <button
                  onClick={() => void refreshProvisionTask()}
                  style={{ border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--bg)', color: 'var(--text)', fontSize: '0.72rem', cursor: 'pointer', padding: '0.1rem 0.45rem', marginRight: '0.35rem' }}
                >
                  刷新
                </button>
                <button
                  onClick={() => {
                    setShowRecentTasks((v) => !v)
                  }}
                  style={{ border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--bg)', color: 'var(--text)', fontSize: '0.72rem', cursor: 'pointer', padding: '0.1rem 0.45rem', marginRight: '0.35rem' }}
                >
                  最近任务
                </button>
                <button
                  onClick={() => setProvisionTask(null)}
                  style={{ border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--bg)', color: 'var(--text)', fontSize: '0.72rem', cursor: 'pointer', padding: '0.1rem 0.45rem' }}
                >
                  关闭
                </button>
              </div>
              <div style={{ marginTop: '0.25rem', height: '6px', background: 'rgba(148,163,184,0.35)', borderRadius: '999px' }}>
                <div style={{ width: `${Math.max(0, Math.min(100, provisionTask.progress))}%`, height: '100%', background: 'var(--accent)', borderRadius: '999px' }} />
              </div>
              {showRecentTasks && (
                <div style={{ marginTop: '0.45rem', borderTop: '1px dashed var(--border)', paddingTop: '0.35rem' }}>
                  <div style={{ marginBottom: '0.35rem', display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>筛选</span>
                    <select
                      value={recentTaskFilter}
                      onChange={(e) => setRecentTaskFilter(e.target.value as 'all' | 'running' | 'success' | 'failed')}
                      style={{ border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--bg)', color: 'var(--text)', fontSize: '0.72rem', padding: '0.1rem 0.35rem' }}
                    >
                      <option value="all">全部</option>
                      <option value="running">进行中</option>
                      <option value="success">成功</option>
                      <option value="failed">失败</option>
                    </select>
                  </div>
                  {recentTasks.length === 0 && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>暂无历史任务</div>}
                  {recentTasks.map((t) => (
                    <div
                      key={t.taskId}
                      style={{
                        fontSize: '0.72rem',
                        color: t.status === 'failed' ? '#ef4444' : 'var(--text-muted)',
                        marginBottom: '0.28rem',
                        padding: '0.2rem 0.3rem',
                        border: '1px solid var(--border)',
                        borderRadius: '6px',
                        background: t.status === 'failed' ? 'rgba(239,68,68,0.08)' : 'transparent',
                      }}
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
            <div style={{ padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)', background: 'rgba(245,158,11,0.12)', color: '#f59e0b', fontSize: '0.8rem' }}>
              {workspaceSyncError}
            </div>
          )}
          <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
            {['project_home', 'cluster_home', 'component_home'].includes(currentView)
              ? `项目工作区 / ${selectedProject?.name ?? '未选择项目'}`
              : `节点工作区 / ${nodeLabel}`}
          </div>
          {renderView()}
        </main>
      </div>
      <StatusBar collectorMode={collectorMode} connected={connected} eventCount={eventCount} lastEventType={lastEventType} wsConnected={wsConnected} />
      {showTemplateDialog && (
        <TemplateDialog
          onConfirm={handleTemplateConfirm}
          onCancel={() => setShowTemplateDialog(false)}
        />
      )}
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
