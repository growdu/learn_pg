import { useEffect, useState } from 'react'
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
import ClusterView from './components/cluster/ClusterView'
import { useVisualizationData } from './hooks/useVisualizationData'
import { useWebSocket } from './hooks/useWebSocket'
import { usePGStore } from './stores/pgStore'

export type View = 'cluster' | 'node_home' | 'sql' | 'write' | 'read' | 'transaction' | 'xact_state' | 'wal' | 'clog' | 'buffer' | 'lock' | 'memory' | 'plan'

function App() {
  const [currentView, setCurrentView] = useState<View>('cluster')
  const [connected, setConnected] = useState(false)
  const [pgVersion, setPgVersion] = useState('')
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
    const handler = (evt: Event) => {
      const custom = evt as CustomEvent<{ view?: View }>
      const targetView = custom.detail?.view || 'node_home'
      setConnected(true)
      setCurrentView(targetView)
      const latestVersion = usePGStore.getState().version
      if (latestVersion) setPgVersion(latestVersion)
    }
    window.addEventListener('pgv-node-activated', handler)
    return () => window.removeEventListener('pgv-node-activated', handler)
  }, [])

  const renderView = () => {
    if (currentView !== 'cluster' && !connected) {
      return (
        <div style={{ padding: '2rem' }}>
          <h2 style={{ marginTop: 0 }}>当前没有激活节点</h2>
          <p style={{ color: 'var(--text-muted)' }}>
            请先进入集群主页，选择一个节点并点击“激活”或“观测”，再进入节点级观测页面。
          </p>
          <button
            onClick={() => setCurrentView('cluster')}
            style={{ padding: '0.5rem 0.9rem', border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--bg-secondary)', color: 'var(--text)', cursor: 'pointer' }}
          >
            返回集群主页
          </button>
        </div>
      )
    }

    switch (currentView) {
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
      case 'cluster':
        return <ClusterView />
      case 'node_home':
        return <NodeHomeView onNavigate={setCurrentView} nodeLabel={nodeLabel} />
      case 'sql':
        return <SQLConsole />
      default:
        return <NodeHomeView onNavigate={setCurrentView} nodeLabel={nodeLabel} />
    }
  }

  const nodeActive = connected
  const nodeLabel = `${storeConfig.host}:${storeConfig.port}/${storeConfig.database}`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Header connected={connected} pgVersion={pgVersion} wsConnected={wsConnected} />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <Sidebar
          currentView={currentView}
          onNavigate={setCurrentView}
          nodeActive={nodeActive}
          nodeLabel={nodeLabel}
        />
        <main style={{ flex: 1, overflow: 'auto', padding: '0' }}>
          <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
            {currentView === 'cluster' ? '集群工作区 / 全局总览' : `节点工作区 / ${nodeLabel}`}
          </div>
          {renderView()}
        </main>
      </div>
      <StatusBar
        collectorMode={collectorMode}
        connected={connected}
        eventCount={eventCount}
        lastEventType={lastEventType}
        wsConnected={wsConnected}
      />
    </div>
  )
}

export default App
