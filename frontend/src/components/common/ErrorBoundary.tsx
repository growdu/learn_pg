// src/components/common/ErrorBoundary.tsx
//
// Top-level error boundary. Without this, an uncaught render error
// in any descendant tears down the entire React tree and leaves
// the user staring at a blank page. With this, the user sees a
// recovery panel that lets them:
//
//   1. See what happened (error message + stack summary)
//   2. Reload the page (hard reset)
//   3. Reset the boundary's local state (soft reset)
//
// The component is intentionally class-based because React only
// supports componentDidCatch and getDerivedStateFromError on
// class components (no hook equivalent).
//
// We deliberately don't try to recover from the same error twice
// automatically — if reset doesn't work, the user can reload.
//
// The optional `onError` prop is called exactly once per caught
// error so a future telemetry hook (Task 19) can be wired up
// without re-plumbing this component.

import { Component, type ErrorInfo, type ReactNode } from 'react'

export interface ErrorBoundaryProps {
  children: ReactNode
  /** Optional fallback UI. Defaults to the built-in recovery panel. */
  fallback?: (info: ErrorInfoView, actions: ErrorActions) => ReactNode
  /** Called once per caught error, with the same info the fallback sees. */
  onError?: (info: ErrorInfoView) => void
  /** Optional component label shown in the panel; defaults to "Application". */
  label?: string
}

export interface ErrorActions {
  /** Clear the captured error so children re-render from scratch. */
  reset: () => void
  /** Hard reload the page. */
  reload: () => void
}

export interface ErrorInfoView {
  error: Error
  /** Stack trace, trimmed to 4 KB so the recovery panel stays readable. */
  stack: string
  /** Path of the component that threw (best-effort). */
  componentStack: string
  /** Wall-clock time the error was caught. */
  timestamp: Date
}

interface State {
  info: ErrorInfoView | null
}

const STACK_LIMIT_BYTES = 4 * 1024

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  state: State = { info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      info: {
        error,
        stack: trimStack(error.stack ?? '', STACK_LIMIT_BYTES),
        componentStack: '',
        timestamp: new Date(),
      },
    }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Replace the empty componentStack with the real one now that
    // React has given it to us. We avoid setting state during the
    // render-phase derivation above because that triggers warnings.
    this.setState((prev) =>
      prev.info
        ? {
            info: {
              ...prev.info,
              componentStack: trimStack(info.componentStack ?? '', STACK_LIMIT_BYTES),
            },
          }
        : null,
    )
    this.props.onError?.(this.state.info ?? {
      error,
      stack: trimStack(error.stack ?? '', STACK_LIMIT_BYTES),
      componentStack: info.componentStack ?? '',
      timestamp: new Date(),
    })
    // Also forward to the global error reporter so the event ends up
    // on the server even if no onError prop was passed.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('learn_pg:boundary', {
          detail: { error, info: { componentStack: info.componentStack } },
        }),
      )
    }
  }

  override render(): ReactNode {
    const info = this.state.info
    if (!info) return this.props.children

    const actions: ErrorActions = {
      reset: () => this.setState({ info: null }),
      reload: () => {
        if (typeof window !== 'undefined') {
          window.location.reload()
        }
      },
    }

    if (this.props.fallback) {
      return this.props.fallback(info, actions)
    }
    return <DefaultFallback label={this.props.label ?? 'Application'} info={info} actions={actions} />
  }
}

function DefaultFallback({
  label,
  info,
  actions,
}: {
  label: string
  info: ErrorInfoView
  actions: ErrorActions
}): ReactNode {
  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        margin: 0,
        padding: '2rem',
        minHeight: '100vh',
        background: '#1a1a1a',
        color: '#e0e0e0',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
      }}
    >
      <h1 style={{ margin: 0, fontSize: '1.4rem', color: '#ff6b6b' }}>
        {label} encountered an unrecoverable error
      </h1>
      <p style={{ margin: 0, color: '#bdbdbd' }}>
        Something broke while rendering this view. You can try to recover
        without losing your session, or reload the page if that doesn&apos;t help.
      </p>
      <div
        style={{
          background: '#262626',
          padding: '1rem',
          borderRadius: '4px',
          border: '1px solid #404040',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '0.85rem',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflowX: 'auto',
        }}
      >
        <div style={{ color: '#ff8787', marginBottom: '0.5rem' }}>
          {info.error.name}: {info.error.message}
        </div>
        {info.stack && <details><summary>Stack trace</summary><pre>{info.stack}</pre></details>}
        {info.componentStack && (
          <details style={{ marginTop: '0.5rem' }}>
            <summary>Component tree</summary>
            <pre>{info.componentStack}</pre>
          </details>
        )}
        <div style={{ marginTop: '0.5rem', color: '#888', fontSize: '0.75rem' }}>
          Caught at {info.timestamp.toISOString()}
        </div>
      </div>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button
          type="button"
          onClick={actions.reset}
          style={btnStyle('#1976d2')}
        >
          Try to recover
        </button>
        <button
          type="button"
          onClick={actions.reload}
          style={btnStyle('#555')}
        >
          Reload page
        </button>
      </div>
    </div>
  )
}

function btnStyle(bg: string): React.CSSProperties {
  return {
    padding: '0.5rem 1rem',
    background: bg,
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.9rem',
  }
}

function trimStack(s: string, maxBytes: number): string {
  if (s.length <= maxBytes) return s
  const cut = s.slice(0, maxBytes)
  // Try to stop at a newline so we don't slice mid-frame.
  const lastNl = cut.lastIndexOf('\n')
  return (lastNl > 0 ? cut.slice(0, lastNl) : cut) + '\n… (truncated)'
}
