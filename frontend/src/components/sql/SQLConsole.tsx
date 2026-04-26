import { useState, useRef } from 'react'
import type { ExecuteResponse } from '../../types/pg'
import { usePGStore } from '../../stores/pgStore'

// Normalize backend PascalCase fields to camelCase
function normalizeResponse(raw: ExecuteResponse): ExecuteResponse {
  const r = raw.result as unknown as Record<string, unknown>
  if (!r) return raw
  const cols = r.Columns as unknown[] | undefined
  const rows = r.Rows as unknown[] | undefined
  return {
    success: raw.success,
    error: raw.error,
    result: {
      columns: (cols ?? []).map((c: unknown) => {
        const col = c as Record<string, unknown>
        return { name: String(col.Name ?? ''), type: Number(col.Type ?? 0) }
      }),
      rows: (rows ?? []) as Record<string, string>[],
      commandTag: String(r.CommandTag ?? ''),
      error: r.Error as string | undefined,
      errorDetail: r.ErrorDetail as Record<string, string> | undefined,
    },
  }
}

const API_BASE = import.meta.env.VITE_API_URL || ''

interface SQLConsoleProps {}

export default function SQLConsole(_props: SQLConsoleProps) {
  // Global store — persists across page navigations
  const { connected, config } = usePGStore()

  const [sql, setSql] = useState('SELECT 1;')
  const [output, setOutput] = useState('')
  const [loading, setLoading] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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
      const data: ExecuteResponse = await res.json()
      const norm = normalizeResponse(data)
      if (norm.success && norm.result) {
        const result = norm.result
        let out = ''
        if (result.columns?.length) {
          out += result.columns.map((c) => c.name).join('\t') + '\n'
        }
        result.rows?.forEach((row: Record<string, string>) => {
          out += result.columns.map((c) => row[c.name] || '').join('\t') + '\n'
        })
        if (result.commandTag) out += `(${result.commandTag})\n`
        setOutput(out || '(无结果)')
      } else {
        setOutput(`ERROR: ${norm.error || '未知错误'}\n`)
      }
    } catch (e) {
      setOutput(`ERROR: 请求失败 - ${e}\n`)
    }
    setLoading(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* Connection status banner */}
      <div style={{
        padding: '0.5rem 1rem',
        background: 'var(--green)',
        color: 'white',
        borderRadius: '6px',
        fontSize: '0.8rem',
        fontFamily: 'Consolas, monospace',
      }}>
        Connected: {config.host}:{config.port}/{config.database}
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
