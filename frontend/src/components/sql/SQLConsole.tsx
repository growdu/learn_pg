import { useState, useRef, useEffect } from 'react'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000'

interface SQLConsoleProps {
  onConnect: (connected: boolean) => void
  onVersion: (version: string) => void
}

export default function SQLConsole({ onConnect, onVersion }: SQLConsoleProps) {
  const [sql, setSql] = useState('SELECT 1;')
  const [output, setOutput] = useState('')
  const [loading, setLoading] = useState(false)
  const [connected, setConnectedState] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [config, setConfig] = useState({
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    password: 'postgres',
    database: 'postgres',
  })
  const [showConfig, setShowConfig] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    // Auto-connect on mount
    handleConnect()
  }, [])

  const handleConnect = async () => {
    setConnecting(true)
    try {
      const res = await fetch(`${API_BASE}/api/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: config.host,
          port: config.port,
          user: config.user,
          password: config.password,
          database: config.database,
        }),
      })
      const data = await res.json()
      if (data.success) {
        setConnectedState(true)
        onConnect(true)
        if (data.version) {
          onVersion(data.version)
        }
        setOutput(`[连接成功] ${data.version || ''}\n`)
      } else {
        setOutput(`[连接失败] ${data.message}\n`)
        onConnect(false)
      }
    } catch {
      setOutput(`[连接失败] 无法连接到 ${config.host}:${config.port}\n`)
      onConnect(false)
    }
    setConnecting(false)
  }

  const handleExecute = async () => {
    if (!sql.trim()) return
    setLoading(true)
    setOutput('')
    try {
      const res = await fetch(`${API_BASE}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: sql.trim() }),
      })
      const data = await res.json()
      if (data.success && data.result) {
        const result = data.result
        let out = ''
        if (result.columns?.length) {
          out += result.columns.map((c: { Name: string }) => c.Name).join('\t') + '\n'
        }
        result.rows?.forEach((row: Record<string, string>) => {
          out += result.columns.map((c: { Name: string }) => row[c.Name] || '').join('\t') + '\n'
        })
        if (result.commandTag) out += `(${result.commandTag})\n`
        setOutput(out || '(无结果)')
      } else {
        setOutput(`ERROR: ${data.error || '未知错误'}\n`)
      }
    } catch (e) {
      setOutput(`ERROR: 请求失败 - ${e}\n`)
    }
    setLoading(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* Connection Config */}
      <div style={{
        padding: '1rem',
        background: 'var(--bg-secondary)',
        borderRadius: '8px',
        border: '1px solid var(--border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: showConfig ? '1rem' : 0 }}>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
            连接: {config.host}:{config.port}/{config.database}
          </span>
          <button
            onClick={() => setShowConfig(!showConfig)}
            style={{
              padding: '0.25rem 0.75rem',
              background: 'var(--bg-tertiary)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '0.75rem',
            }}
          >
            {showConfig ? '收起' : '配置'}
          </button>
          <button
            onClick={handleConnect}
            disabled={connecting}
            style={{
              padding: '0.25rem 0.75rem',
              background: connected ? 'var(--green)' : 'var(--accent)',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '0.75rem',
            }}
          >
            {connecting ? '连接中...' : (connected ? '重连' : '连接')}
          </button>
        </div>
        {showConfig && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.5rem' }}>
            {(['host', 'port', 'user', 'password', 'database'] as const).map((key) => (
              <div key={key}>
                <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{key}</label>
                <input
                  type={key === 'password' ? 'password' : key === 'port' ? 'number' : 'text'}
                  value={config[key]}
                  onChange={(e) => setConfig({ ...config, [key]: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '0.25rem 0.5rem',
                    background: 'var(--bg)',
                    color: 'var(--text)',
                    border: '1px solid var(--border)',
                    borderRadius: '4px',
                    fontSize: '0.875rem',
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* SQL Input */}
      <div style={{
        padding: '1rem',
        background: 'var(--bg-secondary)',
        borderRadius: '8px',
        border: '1px solid var(--border)',
      }}>
        <textarea
          ref={textareaRef}
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              handleExecute()
            }
          }}
          style={{
            width: '100%',
            minHeight: '120px',
            padding: '0.75rem',
            background: 'var(--bg)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            fontFamily: 'Consolas, Monaco, "Courier New", monospace',
            fontSize: '0.875rem',
            resize: 'vertical',
          }}
          placeholder="输入 SQL 语句，按 Ctrl+Enter 执行"
        />
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
          <button
            onClick={handleExecute}
            disabled={loading || !connected}
            style={{
              padding: '0.5rem 1.5rem',
              background: connected ? 'var(--accent)' : 'var(--bg-tertiary)',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: connected ? 'pointer' : 'not-allowed',
              fontSize: '0.875rem',
            }}
          >
            {loading ? '执行中...' : '执行 (Ctrl+Enter)'}
          </button>
          <button
            onClick={() => setSql('')}
            style={{
              padding: '0.5rem 1rem',
              background: 'transparent',
              color: 'var(--text-muted)',
              border: '1px solid var(--border)',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '0.875rem',
            }}
          >
            清空
          </button>
        </div>
      </div>

      {/* Output */}
      <div style={{
        padding: '1rem',
        background: 'var(--bg)',
        borderRadius: '8px',
        border: '1px solid var(--border)',
        minHeight: '200px',
      }}>
        <div style={{
          fontSize: '0.75rem',
          color: 'var(--text-muted)',
          marginBottom: '0.5rem',
        }}>
          结果
        </div>
        <pre style={{
          fontFamily: 'Consolas, Monaco, "Courier New", monospace',
          fontSize: '0.875rem',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          color: output.startsWith('ERROR') ? 'var(--red)' : 'var(--text)',
        }}>
          {output || '暂无输出'}
        </pre>
      </div>
    </div>
  )
}