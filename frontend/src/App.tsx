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
    const tpl = ALL_TEMPLATES.find((t) => t.id === templateId)!
    const project = tpl.buildProject(name, params, makeDefaultNode)
    const next = [...projects, project]
    setProjects(next)
    setSelectedProjectId(project.id)
    if (project.clusters[0]) setSelectedClusterId(project.clusters[0].id)
    setHighlightedComponentIds(project.components.map((c) => c.id))
    setCurrentView('component_home')
  }

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
