import { useEffect, useState } from 'react'
import Header from './components/layout/Header'
import Sidebar from './components/layout/Sidebar'
import StatusBar from './components/layout/StatusBar'
import ConnectionManager from './components/connection/ConnectionManager'
import SQLConsole from './components/sql/SQLConsole'
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

export type View = 'home' | 'cluster' | 'write' | 'read' | 'transaction' | 'xact_state' | 'wal' | 'clog' | 'buffer' | 'lock' | 'memory' | 'plan'

function App() {
  const [currentView, setCurrentView] = useState<View>('home')
  const [connected, setConnected] = useState(false)
  const [pgVersion, setPgVersion] = useState('')
  const storeConnected = usePGStore((s) => s.connected)
  const storeVersion = usePGStore((s) => s.version)
  const { connected: wsConnected } = useWebSocket()
  const { buffers, collectorMode, eventCount, lastEventType, transactions, writeStages } = useVisualizationData()

  useEffect(() => {
    if (storeConnected) setConnected(true)
    if (storeVersion) setPgVersion(storeVersion)
  }, [storeConnected, storeVersion])

  useEffect(() => {
    const handler = (evt: Event) => {
      const custom = evt as CustomEvent<{ view?: View }>
      const targetView = custom.detail?.view || 'home'
      setConnected(true)
      setCurrentView(targetView)
      const latestVersion = usePGStore.getState().version
      if (latestVersion) setPgVersion(latestVersion)
    }
    window.addEventListener('pgv-node-activated', handler)
    return () => window.removeEventListener('pgv-node-activated', handler)
  }, [])

  const renderView = () => {
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
      default:
        return connected ? (
          <SQLConsole />
        ) : (
          <ConnectionManager onConnect={setConnected} onVersion={setPgVersion} />
        )
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Header connected={connected} pgVersion={pgVersion} wsConnected={wsConnected} />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <Sidebar currentView={currentView} onNavigate={setCurrentView} />
        <main style={{ flex: 1, overflow: 'auto', padding: '0' }}>
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
