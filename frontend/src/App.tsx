import { useState } from 'react'
import Header from './components/layout/Header'
import Sidebar from './components/layout/Sidebar'
import StatusBar from './components/layout/StatusBar'
import SQLConsole from './components/sql/SQLConsole'
import WALViewer from './components/wal/WALViewer'
import CLOGViewer from './components/clog/CLOGViewer'
import PipelineView from './components/pipeline/PipelineView'
import BufferHeatmapView from './components/buffer/BufferHeatmapView'
import LockGraphView from './components/lock/LockGraphView'
import MemoryStructView from './components/memory/MemoryStructView'
import PlanTreeView from './components/pipeline/PlanTreeView'
import TransactionStateView from './components/transaction/TransactionStateView'
import { useVisualizationData } from './hooks/useVisualizationData'
import { useWebSocket } from './hooks/useWebSocket'

type View = 'home' | 'write' | 'read' | 'transaction' | 'xact_state' | 'wal' | 'clog' | 'buffer' | 'lock' | 'memory' | 'plan'

function App() {
  const [currentView, setCurrentView] = useState<View>('home')
  const [connected, setConnected] = useState(false)
  const [pgVersion, setPgVersion] = useState('')
  const { connected: wsConnected } = useWebSocket()
  const { buffers, collectorMode, eventCount, lastEventType, transactions, writeStages } = useVisualizationData()

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
      default:
        return (
          <div style={{ padding: '2rem' }}>
            <h1 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>PostgreSQL 内核可视化平台</h1>
            <p style={{ color: 'var(--text-muted)', marginBottom: '2rem' }}>
              PG Version: {pgVersion || '未连接'}
            </p>
            <SQLConsole onConnect={setConnected} onVersion={setPgVersion} />
          </div>
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
