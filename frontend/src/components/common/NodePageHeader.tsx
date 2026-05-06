import type { ReactNode } from 'react'

interface NodePageHeaderProps {
  title: string
  source?: string
  updatedAtText?: string
  rightSlot?: ReactNode
}

export default function NodePageHeader({
  title,
  source,
  updatedAtText,
  rightSlot,
}: NodePageHeaderProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1rem', gap: '1rem' }}>
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
      {rightSlot ? <div>{rightSlot}</div> : null}
    </div>
  )
}
