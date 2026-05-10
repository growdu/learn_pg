import { useState, useEffect } from 'react'
import { usePGStore, type PGConfig } from '../../stores/pgStore'
import '../../styles/index.css'

export interface ConnectionProfile {
  id: string
  name: string
  host: string
  port: number
  user: string
  password: string
  database: string
}

const STORAGE_KEY = 'pgv_profiles'

function loadProfiles(): ConnectionProfile[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return [
    {
      id: 'default',
      name: 'Local PostgreSQL',
      host: 'localhost',
      port: 5432,
      user: 'postgres',
      password: 'postgres',
      database: 'postgres',
    },
  ]
}

function saveProfiles(profiles: ConnectionProfile[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles))
}

interface Props {
  onConnect: (connected: boolean) => void
  onVersion: (version: string) => void
}

export default function ConnectionManager({ onConnect, onVersion }: Props) {
  const { connected, setConfig, setConnected, setVersion } = usePGStore()
  const [profiles, setProfiles] = useState<ConnectionProfile[]>(loadProfiles)
  const [activeProfile, setActiveProfile] = useState<ConnectionProfile | null>(null)
  const [editingProfile, setEditingProfile] = useState<Partial<ConnectionProfile> | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (connected) {
      const cfg = usePGStore.getState().config
      setActiveProfile({ id: 'current', name: 'Current', ...cfg })
    }
  }, [connected, setActiveProfile])

  const handleConnect = async (profile: ConnectionProfile) => {
    setConnecting(true)
    setError('')
    try {
      const res = await fetch('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: profile.host,
          port: profile.port,
          user: profile.user,
          password: profile.password,
          database: profile.database,
        }),
      })
      const data = await res.json()
      if (data.success) {
        const cfg: PGConfig = {
          host: profile.host,
          port: profile.port,
          user: profile.user,
          password: profile.password,
          database: profile.database,
        }
        setConfig(cfg)
        setConnected(true)
        setVersion(data.version || '')
        setActiveProfile({ ...profile, id: profile.id || 'current' })
        onConnect(true)
        if (data.version) onVersion(data.version)
      } else {
        setError(data.message || 'Connection failed')
      }
    } catch (e) {
      setError(`Cannot connect to ${profile.host}:${profile.port}`)
    }
    setConnecting(false)
  }

  const handleSaveProfile = () => {
    if (!editingProfile?.name || !editingProfile?.host) return
    const profile: ConnectionProfile = {
      id: editingProfile.id || (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)),
      name: editingProfile.name,
      host: editingProfile.host || 'localhost',
      port: editingProfile.port || 5432,
      user: editingProfile.user || 'postgres',
      password: editingProfile.password || '',
      database: editingProfile.database || 'postgres',
    }
    let updated: ConnectionProfile[]
    if (profiles.find((p) => p.id === profile.id)) {
      updated = profiles.map((p) => (p.id === profile.id ? profile : p))
    } else {
      updated = [...profiles, profile]
    }
    setProfiles(updated)
    saveProfiles(updated)
    setEditingProfile(null)
    setIsEditing(false)
  }

  const handleDeleteProfile = (id: string) => {
    const updated = profiles.filter((p) => p.id !== id)
    setProfiles(updated)
    saveProfiles(updated)
  }

  const startAdd = () => {
    const cfg = usePGStore.getState().config
    setEditingProfile({ host: cfg.host, port: cfg.port, user: cfg.user, password: '', database: cfg.database })
    setIsEditing(true)
  }

  const startEdit = (p: ConnectionProfile) => {
    setEditingProfile({ ...p })
    setIsEditing(true)
  }

  const cancelEdit = () => {
    setEditingProfile(null)
    setIsEditing(false)
  }

  if (isEditing && editingProfile) {
    return (
      <div className="panel panel-sm fade-in">
        <h2 className="section-title" style={{ marginBottom: '1.5rem' }}>
          {editingProfile.id && profiles.find((p) => p.id === editingProfile.id) ? 'Edit Connection' : 'New Connection'}
        </h2>
        <div className="input-grid">
          <div className="input-group">
            <label className="input-label">Profile Name</label>
            <input
              className="input"
              value={editingProfile.name || ''}
              onChange={(e) => setEditingProfile({ ...editingProfile, name: e.target.value })}
              placeholder="Local PG 18"
            />
          </div>
          <div className="input-row">
            <div className="input-group" style={{ flex: 1 }}>
              <label className="input-label">Host</label>
              <input
                className="input"
                value={editingProfile.host || ''}
                onChange={(e) => setEditingProfile({ ...editingProfile, host: e.target.value })}
                placeholder="localhost"
              />
            </div>
            <div className="input-group" style={{ width: '100px' }}>
              <label className="input-label">Port</label>
              <input
                className="input"
                type="number"
                value={editingProfile.port || 5432}
                onChange={(e) => setEditingProfile({ ...editingProfile, port: Number(e.target.value) })}
              />
            </div>
          </div>
          <div className="input-row">
            <div className="input-group" style={{ flex: 1 }}>
              <label className="input-label">User</label>
              <input
                className="input"
                value={editingProfile.user || ''}
                onChange={(e) => setEditingProfile({ ...editingProfile, user: e.target.value })}
                placeholder="postgres"
              />
            </div>
            <div className="input-group" style={{ flex: 1 }}>
              <label className="input-label">Password</label>
              <input
                className="input"
                type="password"
                value={editingProfile.password || ''}
                onChange={(e) => setEditingProfile({ ...editingProfile, password: e.target.value })}
                placeholder="••••••••"
              />
            </div>
          </div>
          <div className="input-group">
            <label className="input-label">Database</label>
            <input
              className="input"
              value={editingProfile.database || ''}
              onChange={(e) => setEditingProfile({ ...editingProfile, database: e.target.value })}
              placeholder="postgres"
            />
          </div>
          <div className="flex gap-sm" style={{ marginTop: '0.5rem' }}>
            <button className="btn" onClick={handleSaveProfile}>
              Save
            </button>
            <button className="btn btn-ghost" onClick={cancelEdit}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="panel fade-in">
      <div className="section-header">
        <div>
          <h1 className="section-title">PostgreSQL Kernel Visualizer</h1>
          <p className="section-subtitle">Select a server to connect</p>
        </div>
        <button className="btn" onClick={startAdd}>
          + New Connection
        </button>
      </div>

      {error && (
        <div className="alert alert-error" style={{ marginBottom: '1rem' }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 3a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 4zm0 8a1 1 0 100-2 1 1 0 000 2z"/>
          </svg>
          {error}
        </div>
      )}

      <div className="flex flex-col gap-md">
        {profiles.map((profile) => {
          const isActive = activeProfile?.id === profile.id && connected
          return (
            <div key={profile.id} className={`card ${isActive ? 'card-active' : ''}`}>
              <div>
                <div className="card-title">{profile.name}</div>
                <div className="card-subtitle">
                  {profile.host}:{profile.port}/{profile.database}
                </div>
                <div className="card-meta">user: {profile.user}</div>
              </div>
              <div className="flex gap-sm items-center">
                {isActive ? (
                  <span className="badge badge-success">
                    <span className="pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', display: 'inline-block', marginRight: 4 }} />
                    Connected
                  </span>
                ) : (
                  <button
                    className="btn btn-sm"
                    onClick={() => handleConnect(profile)}
                    disabled={connecting}
                  >
                    {connecting ? 'Connecting...' : 'Connect'}
                  </button>
                )}
                <button className="btn btn-sm btn-ghost" onClick={() => startEdit(profile)}>
                  Edit
                </button>
                {profile.id !== 'default' && (
                  <button className="btn btn-sm btn-danger" onClick={() => handleDeleteProfile(profile.id)}>
                    Del
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ marginTop: '2rem', padding: '1.5rem', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)' }}>
        <h3 className="card-title" style={{ marginBottom: '0.75rem' }}>Quick Tips</h3>
        <ul style={{ color: 'var(--text-muted)', fontSize: 'var(--font-sm)', listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <li className="flex items-center gap-sm">
            <span style={{ color: 'var(--accent)' }}>→</span>
            Make sure PostgreSQL is running and accessible
          </li>
          <li className="flex items-center gap-sm">
            <span style={{ color: 'var(--accent)' }}>→</span>
            Check pg_hba.conf for authentication settings
          </li>
          <li className="flex items-center gap-sm">
            <span style={{ color: 'var(--accent)' }}>→</span>
            For remote hosts, ensure listen_addresses includes the interface
          </li>
        </ul>
      </div>
    </div>
  )
}
