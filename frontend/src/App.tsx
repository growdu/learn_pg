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
import TransactionStateView from './components/transaction/TransactionStateView'
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
const genId = () => crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)

function loadProjects(): WorkspaceProject[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as WorkspaceProject[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveProjects(projects: WorkspaceProject[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projects))
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
    saveProjects(projects)
  }, [projects])

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
    const cluster = { id: genId(), name: `集群 ${idx}`, replicationType: 'physical' as const, nodes: [makeDefaultNode(1)] }
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
        return <TransactionStateView transactions={transactions.length > 0 ? transactions : undefined} />
      case 'buffer':
        return <BufferHeatmapView buffers={buffers.length > 0 ? buffers : undefined} />
      case 'lock':
        return <LockGraphView />
      case 'memory':
        return <MemoryStructView />
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
