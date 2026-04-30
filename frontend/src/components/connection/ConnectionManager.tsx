import { useState, useEffect } from 'react'
import { usePGStore, type PGConfig } from '../../stores/pgStore'

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
      host: 'pgv-postgres',
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

  // Sync global store to active profile on mount
  useEffect(() => {
    if (connected) {
      const cfg = usePGStore.getState().config
      setActiveProfile({ id: 'current', name: 'Current', ...cfg })
    }
  }, [])

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
      <div style={{ padding: '2rem', maxWidth: '600px', margin: '0 auto' }}>
        <h2 style={{ color: 'var(--text)', marginBottom: '1.5rem' }}>
          {editingProfile.id && profiles.find((p) => p.id === editingProfile.id) ? 'Edit Connection' : 'New Connection'}
        </h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <label style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>Profile Name</label>
            <input
              value={editingProfile.name || ''}
              onChange={(e) => setEditingProfile({ ...editingProfile, name: e.target.value })}
              placeholder="Local PG 18"
              style={inputStyle}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: '0.5rem' }}>
            <div>
              <label style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>Host</label>
              <input value={editingProfile.host || ''} onChange={(e) => setEditingProfile({ ...editingProfile, host: e.target.value })} style={inputStyle} />
            </div>
            <div>
              <label style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>Port</label>
              <input type="number" value={editingProfile.port || 5432} onChange={(e) => setEditingProfile({ ...editingProfile, port: Number(e.target.value) })} style={inputStyle} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
            <div>
              <label style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>User</label>
              <input value={editingProfile.user || ''} onChange={(e) => setEditingProfile({ ...editingProfile, user: e.target.value })} style={inputStyle} />
            </div>
            <div>
              <label style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>Password</label>
              <input type="password" value={editingProfile.password || ''} onChange={(e) => setEditingProfile({ ...editingProfile, password: e.target.value })} style={inputStyle} />
            </div>
          </div>
          <div>
            <label style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>Database</label>
            <input value={editingProfile.database || ''} onChange={(e) => setEditingProfile({ ...editingProfile, database: e.target.value })} style={inputStyle} />
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button onClick={handleSaveProfile} style={{ ...btnStyle, background: 'var(--accent)' }}>
              Save
            </button>
            <button onClick={cancelEdit} style={{ ...btnStyle, background: 'var(--bg-tertiary)' }}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: '2rem', maxWidth: '700px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '1.5rem', color: 'var(--text)', margin: 0 }}>PostgreSQL 内核可视化平台</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', margin: '0.25rem 0 0' }}>选择服务器连接</p>
        </div>
        <button onClick={startAdd} style={{ ...btnStyle, background: 'var(--accent)' }}>
          + New Connection
        </button>
      </div>

      {error && (
        <div style={{ padding: '0.75rem', background: 'rgba(239,68,68,0.1)', border: '1px solid var(--red)', borderRadius: '8px', color: 'var(--red)', fontSize: '0.875rem', marginBottom: '1rem' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {profiles.map((profile) => (
          <div
            key={profile.id}
            style={{
              padding: '1rem 1.25rem',
              background: 'var(--bg-secondary)',
              border: `1px solid ${activeProfile?.id === profile.id ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: '0.25rem' }}>{profile.name}</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontFamily: 'Consolas, monospace' }}>
                {profile.host}:{profile.port}/{profile.database}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>user: {profile.user}</div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <button
                onClick={() => handleConnect(profile)}
                disabled={connecting}
                style={{
                  ...btnStyle,
                  background: activeProfile?.id === profile.id && connected ? 'var(--green)' : 'var(--accent)',
                }}
              >
                {connecting ? '...' : activeProfile?.id === profile.id && connected ? 'Connected' : 'Connect'}
              </button>
              <button onClick={() => startEdit(profile)} style={{ ...btnStyle, background: 'var(--bg-tertiary)', padding: '0.25rem 0.75rem', fontSize: '0.75rem' }}>
                Edit
              </button>
              {profile.id !== 'default' && (
                <button onClick={() => handleDeleteProfile(profile.id)} style={{ ...btnStyle, background: 'rgba(239,68,68,0.1)', color: 'var(--red)', padding: '0.25rem 0.75rem', fontSize: '0.75rem' }}>
                  Del
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.5rem 0.75rem',
  background: 'var(--bg)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: '6px',
  fontSize: '0.875rem',
  boxSizing: 'border-box',
}

const btnStyle: React.CSSProperties = {
  padding: '0.4rem 1rem',
  color: 'white',
  border: 'none',
  borderRadius: '6px',
  cursor: 'pointer',
  fontSize: '0.875rem',
  fontWeight: 500,
}
