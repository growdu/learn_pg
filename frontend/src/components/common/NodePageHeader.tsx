import type { ReactNode } from 'react'

interface NodePageHeaderProps {
  title: string
  source?: string
  updatedAtText?: string
  rightSlot?: ReactNode
  onBack?: () => void
}

export default function NodePageHeader({
  title,
  source,
  updatedAtText,
  rightSlot,
  onBack,
}: NodePageHeaderProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1rem', gap: '1rem', flexWrap: 'wrap' }}>
      <div>
        <h2 style={{ fontSize: '1.25rem', margin: 0 }}>{title}</h2>
        {(source || updatedAtText) && (
          <div style={{ marginTop: '0.35rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {source ? `数据来源：${source}` : ''}
            {source && updatedAtText ? ' | ' : ''}
            {updatedAtText ? `更新时间：${updatedAtText}` : ''}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
        {rightSlot && <div>{rightSlot}</div>}
        {onBack && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={onBack}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
            返回集群
          </button>
        )}
      </div>
    </div>
  )
}
