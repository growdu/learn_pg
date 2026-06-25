import { useState, useEffect, useCallback } from 'react'
import type { WorkspaceHost } from '../../types/host'

interface Props {
  onGoBack: () => void
}

interface DiscoveryHost {
  host: string
  port: number
  service: string
  version?: string
  confidence: 'high' | 'medium' | 'low'
}

export default function HostManagementView({ onGoBack }: Props) {
  const [hosts, setHosts] = useState<WorkspaceHost[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  // Add form state
  const [formName, setFormName] = useState('')
  const [formHost, setFormHost] = useState('')
  const [formPort, setFormPort] = useState(22)
  const [formUser, setFormUser] = useState('root')
  const [formKey, setFormKey] = useState('')
  const [formSubmitting, setFormSubmitting] = useState(false)

  // Scan state
  const [scanHost, setScanHost] = useState('')
  const [scanPort, setScanPort] = useState(5432)
  const [scanResult, setScanResult] = useState<DiscoveryHost | null>(null)
  const [scanning, setScanning] = useState(false)

  const loadHosts = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/hosts')
      const data = (await res.json()) as { success?: boolean; hosts?: WorkspaceHost[] }
      if (!data.success) throw new Error('failed to load hosts')
      setHosts(data.hosts ?? [])
    } catch (e) {
      setError('加载主机列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadHosts() }, [loadHosts])

  const handleAddHost = async () => {
    if (!formName.trim() || !formHost.trim()) return
    setFormSubmitting(true)
    try {
      const res = await fetch('/api/hosts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName.trim(),
          host: formHost.trim(),
          port: formPort,
          sshUser: formUser.trim() || 'root',
          sshKey: formKey || undefined,
        }),
      })
      const data = (await res.json()) as { success?: boolean }
      if (!data.success) throw new Error('create failed')
      await loadHosts()
      setShowAdd(false)
      setFormName('')
      setFormHost('')
      setFormPort(22)
      setFormUser('root')
      setFormKey('')
    } catch {
      setError('添加主机失败')
    } finally {
      setFormSubmitting(false)
    }
  }

  const handleDeleteHost = async (id: string) => {
    try {
      const res = await fetch(`/api/hosts/${id}`, { method: 'DELETE' })
      const data = (await res.json()) as { success?: boolean }
      if (!data.success) throw new Error('delete failed')
      await loadHosts()
    } catch {
      setError('删除主机失败')
    }
  }

  const handleUpdateHost = async (id: string) => {
    try {
      const res = await fetch(`/api/hosts/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName.trim(),
          host: formHost.trim(),
          port: formPort,
          sshUser: formUser.trim() || 'root',
          sshKey: formKey || undefined,
        }),
      })
      const data = (await res.json()) as { success?: boolean }
      if (!data.success) throw new Error('update failed')
      await loadHosts()
      setEditingId(null)
      setFormName('')
      setFormHost('')
      setFormPort(22)
      setFormUser('root')
      setFormKey('')
    } catch {
      setError('更新主机失败')
    }
  }

  const startEdit = (h: WorkspaceHost) => {
    setEditingId(h.id)
    setFormName(h.name)
    setFormHost(h.host)
    setFormPort(h.port)
    setFormUser(h.sshUser)
    setFormKey(h.sshKey ?? '')
  }

  const handleScan = async () => {
    if (!scanHost.trim()) return
    setScanning(true)
    setScanResult(null)
    try {
      const res = await fetch('/api/discovery/host/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: scanHost.trim(),
          ssh: { port: scanPort > 0 ? scanPort : 5432 },
        }),
      })
      const data = (await res.json()) as { success?: boolean; instances?: DiscoveryHost[] }
      if (!data.success) throw new Error('scan failed')
      setScanResult(data.instances?.[0] ?? null)
    } catch {
      setError('扫描主机失败')
    } finally {
      setScanning(false)
    }
  }

  return (
    <div style={{ padding: '1.5rem', maxWidth: '900px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
        <button className="btn-ghost" onClick={onGoBack}>← 返回</button>
        <h2 style={{ margin: 0, fontSize: '1.1rem' }}>主机管理</h2>
        <button className="btn-primary" style={{ marginLeft: 'auto' }} onClick={() => { setShowAdd(true); setEditingId(null) }}>+ 添加主机</button>
      </div>

      {error && (
        <div style={{ color: 'var(--red)', fontSize: '0.85rem', marginBottom: '1rem' }}>{error}</div>
      )}

      {/* Scan Section */}
      <div style={{ background: 'var(--bg-secondary)', borderRadius: '8px', padding: '1rem', marginBottom: '1.5rem', border: '1px solid var(--border)' }}>
        <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.75rem', color: 'var(--text-muted)' }}>主机扫描</div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            主机地址
            <input
              className="input"
              value={scanHost}
              onChange={(e) => setScanHost(e.target.value)}
              placeholder="192.168.1.100"
              style={{ width: '160px' }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            端口
            <input
              className="input"
              type="number"
              value={scanPort}
              onChange={(e) => setScanPort(parseInt(e.target.value) || 5432)}
              placeholder="5432"
              style={{ width: '80px' }}
            />
          </label>
          <button
            className="btn-primary"
            onClick={() => void handleScan()}
            disabled={scanning}
            style={{ flexShrink: 0 }}
          >
            {scanning ? '扫描中…' : '扫描'}
          </button>
        </div>

        {scanResult && (
          <div style={{ marginTop: '0.75rem', padding: '0.75rem', background: 'var(--bg-primary)', borderRadius: '6px', fontSize: '0.82rem', border: '1px solid var(--border)' }}>
            <div><strong>Host:</strong> {scanResult.host}:{scanResult.port}</div>
            <div><strong>Service:</strong> {scanResult.service}</div>
            <div><strong>Version:</strong> {scanResult.version ?? 'N/A'}</div>
            <div>
              <strong>Confidence:</strong>{' '}
              <span style={{ color: scanResult.confidence === 'high' ? 'var(--green)' : scanResult.confidence === 'medium' ? 'var(--yellow)' : 'var(--red)' }}>
                {scanResult.confidence}
              </span>
            </div>
            <button
              className="btn-primary"
              style={{ marginTop: '0.5rem', fontSize: '0.78rem', padding: '0.3rem 0.8rem' }}
              onClick={() => {
                setFormHost(scanResult.host)
                setFormPort(scanResult.port)
                setShowAdd(true)
              }}
            >
              导入到主机列表
            </button>
          </div>
        )}
      </div>

      {/* Host List */}
      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>加载中…</div>
      ) : hosts.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>暂无主机，请添加或扫描导入</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {hosts.map((h) => (
            <div
              key={h.id}
              style={{
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                padding: '0.85rem 1rem',
              }}
            >
              {editingId === h.id ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      名称
                      <input className="input" value={formName} onChange={(e) => setFormName(e.target.value)} style={{ width: '120px' }} />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      主机地址
                      <input className="input" value={formHost} onChange={(e) => setFormHost(e.target.value)} style={{ width: '150px' }} />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      SSH 端口
                      <input className="input" type="number" value={formPort} onChange={(e) => setFormPort(parseInt(e.target.value) || 22)} style={{ width: '70px' }} />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      SSH 用户
                      <input className="input" value={formUser} onChange={(e) => setFormUser(e.target.value)} style={{ width: '90px' }} />
                    </label>
                  </div>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    SSH 私钥（可选）
                    <textarea
                      className="input"
                      value={formKey}
                      onChange={(e) => setFormKey(e.target.value)}
                      rows={3}
                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                      style={{ resize: 'vertical' }}
                    />
                  </label>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button className="btn-primary" style={{ fontSize: '0.78rem', padding: '0.3rem 0.8rem' }} onClick={() => void handleUpdateHost(h.id)}>保存</button>
                    <button className="btn-ghost" style={{ fontSize: '0.78rem', padding: '0.3rem 0.8rem' }} onClick={() => { setEditingId(null); setError('') }}>取消</button>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{h.name}</div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                      {h.host}:{h.port}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      SSH: {h.sshUser}@{h.host}:{h.port}
                      {h.sshKey ? ' 🔑' : ''}
                    </div>
                  </div>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.4rem' }}>
                    <button
                      className="btn-ghost"
                      style={{ fontSize: '0.75rem', padding: '0.25rem 0.6rem' }}
                      onClick={() => startEdit(h)}
                    >
                      编辑
                    </button>
                    <button
                      className="btn-ghost"
                      style={{ fontSize: '0.75rem', padding: '0.25rem 0.6rem', color: 'var(--red)' }}
                      onClick={() => void handleDeleteHost(h.id)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Add Host Dialog */}
      {showAdd && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
        }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowAdd(false) }}
        >
          <div style={{
            background: 'var(--bg-primary)', borderRadius: '12px', padding: '1.5rem',
            width: '480px', maxWidth: '90vw', border: '1px solid var(--border)',
          }}>
            <h3 style={{ margin: '0 0 1rem', fontSize: '1rem' }}>添加主机</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                名称 *
                <input className="input" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="my-server" />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                主机地址 *
                <input className="input" value={formHost} onChange={(e) => setFormHost(e.target.value)} placeholder="192.168.1.100" />
              </label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  SSH 端口
                  <input className="input" type="number" value={formPort} onChange={(e) => setFormPort(parseInt(e.target.value) || 22)} style={{ width: '80px' }} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  SSH 用户
                  <input className="input" value={formUser} onChange={(e) => setFormUser(e.target.value)} placeholder="root" style={{ flex: 1 }} />
                </label>
              </div>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                SSH 私钥内容（可选，用于远程主机）
                <textarea
                  className="input"
                  value={formKey}
                  onChange={(e) => setFormKey(e.target.value)}
                  rows={4}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '0.75rem' }}
                />
              </label>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
              <button className="btn-ghost" onClick={() => setShowAdd(false)}>取消</button>
              <button
                className="btn-primary"
                onClick={() => void handleAddHost()}
                disabled={formSubmitting || !formName.trim() || !formHost.trim()}
              >
                {formSubmitting ? '添加中…' : '添加'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
