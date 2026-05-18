import { useEffect, useState } from 'react'

interface TaskToast {
  taskId: string
  status: string
  progress: number
  message: string
  startedAt?: number
  finishedAt?: number
  projectId?: string
  clusterId?: string
}

interface Props {
  task: TaskToast | null
  onDismiss: () => void
}

export default function ToastNotification({ task, onDismiss }: Props) {
  const [visible, setVisible] = useState(false)
  const [exiting, setExiting] = useState(false)

  useEffect(() => {
    if (task) {
      setVisible(true)
      setExiting(false)
    } else {
      setExiting(true)
      const t = setTimeout(() => setVisible(false), 300)
      return () => clearTimeout(t)
    }
  }, [task])

  useEffect(() => {
    if (!task) return
    if (task.status === 'success') {
      const t = setTimeout(() => onDismiss(), 2200)
      return () => clearTimeout(t)
    }
  }, [task, onDismiss])

  if (!visible) return null

  const isRunning = task?.status === 'running'
  const isSuccess = task?.status === 'success'
  const isFailed = task?.status === 'failed'

  const statusColor = isRunning ? 'var(--blue)' : isSuccess ? 'var(--green)' : 'var(--red)'
  const statusBg = isRunning ? 'var(--blue-bg)' : isSuccess ? 'var(--green-bg)' : 'var(--red-bg)'

  return (
    <div
      style={{
        position: 'fixed',
        top: '1rem',
        right: '1rem',
        zIndex: 9999,
        width: '360px',
        maxWidth: 'calc(100vw - 2rem)',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: '10px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
        overflow: 'hidden',
        opacity: exiting ? 0 : 1,
        transform: exiting ? 'translateX(120%)' : 'translateX(0)',
        transition: 'opacity 0.3s ease, transform 0.3s ease',
      }}
    >
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0.7rem 0.9rem',
        borderBottom: isRunning ? '1px solid var(--border)' : 'none',
        background: statusBg,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {isRunning && (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" strokeWidth="2.5" style={{ animation: 'spin 1s linear infinite' }}>
              <path d="M21 12a9 9 0 1 1-6.22-8.56" />
            </svg>
          )}
          {isSuccess && (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
          {isFailed && (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--red)" strokeWidth="2.5">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
          )}
          <span style={{ fontSize: '0.82rem', fontWeight: 600, color: statusColor }}>
            {isRunning ? '进行中' : isSuccess ? '成功' : '失败'}
          </span>
        </div>
        <button
          onClick={onDismiss}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-muted)',
            padding: '0.1rem 0.3rem',
            fontSize: '1rem',
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>

      {/* Body */}
      <div style={{ padding: '0.7rem 0.9rem' }}>
        {/* Message */}
        <div style={{ fontSize: '0.82rem', color: 'var(--text)', marginBottom: isRunning ? '0.6rem' : 0 }}>
          {task?.message || '处理中...'}
        </div>

        {/* Progress bar */}
        {isRunning && (
          <>
            <div style={{
              height: '4px',
              background: 'var(--bg)',
              borderRadius: '2px',
              overflow: 'hidden',
              marginBottom: '0.4rem',
            }}>
              <div style={{
                height: '100%',
                width: `${task?.progress ?? 0}%`,
                background: `linear-gradient(90deg, var(--blue) 0%, var(--accent) 100%)`,
                borderRadius: '2px',
                transition: 'width 0.3s ease',
              }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              <span>{task?.progress ?? 0}%</span>
              <span>项目: {task?.projectId ? `${task.projectId.slice(0, 8)}...` : '-'}</span>
            </div>
          </>
        )}

        {/* Failed details */}
        {isFailed && (
          <div style={{ marginTop: '0.4rem', fontSize: '0.75rem', color: 'var(--red)' }}>
            点击查看详情
          </div>
        )}

        {/* Success */}
        {isSuccess && (
          <div style={{ marginTop: '0.2rem', fontSize: '0.75rem', color: 'var(--green)' }}>
            任务已完成
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
