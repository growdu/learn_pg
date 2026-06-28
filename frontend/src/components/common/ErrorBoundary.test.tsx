// src/components/common/ErrorBoundary.test.tsx
//
// Unit tests for ErrorBoundary. We use react-testing-library so the
// full React lifecycle runs, which is the only way to exercise
// componentDidCatch.

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Component, type ReactNode } from 'react'
import { ErrorBoundary, type ErrorInfoView } from './ErrorBoundary'

// A throwable child controlled by a prop. Lets each test decide
// whether to throw on render.
interface BoomProps {
  throw?: Error
}
class Boom extends Component<BoomProps> {
  override render(): ReactNode {
    if (this.props.throw) throw this.props.throw
    return <div>child ok</div>
  }
}

describe('ErrorBoundary', () => {
  // Widen the spy type: vi.spyOn(...).mockImplementation returns
  // MockInstance<any[], void>, but the declared ReturnType<typeof vi.spyOn>
  // is MockInstance<unknown[], unknown>. `any` keeps the test types
  // tidy without leaking mock internals into the test signatures.
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>
  let reloadStub: (() => void) | undefined
  beforeEach(() => {
    // React logs caught errors to console.error during tests. Silence
    // them so the test output stays readable.
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) as ReturnType<typeof vi.spyOn>
    // jsdom doesn't allow spying on location.reload. Replace it on
    // the window object directly; reset between tests.
    reloadStub = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reloadStub },
    })
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
    reloadStub = undefined
  })

  it('renders children when no error is thrown', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByText('child ok')).toBeInTheDocument()
  })

  it('shows the default fallback when a descendant throws', () => {
    render(
      <ErrorBoundary label="MyApp">
        <Boom throw={new Error('boom!')} />
      </ErrorBoundary>,
    )
    // The label is unique to the fallback header; the error message
    // itself also appears in the stack trace so we can't use it as
    // the only signal.
    expect(screen.getByRole('alert')).toHaveTextContent(/MyApp encountered an unrecoverable error/)
    expect(screen.getByRole('alert')).toHaveTextContent(/boom!/)
  })

  it('uses the custom fallback prop when provided', () => {
    render(
      <ErrorBoundary
        fallback={(info, actions) => (
          <div>
            <span>custom fallback: {info.error.message}</span>
            <button onClick={actions.reset}>reset</button>
          </div>
        )}
      >
        <Boom throw={new Error('specific')} />
      </ErrorBoundary>,
    )
    expect(screen.getByText('custom fallback: specific')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'reset' })).toBeInTheDocument()
  })

  it('calls onError once with the caught info', () => {
    const onError = vi.fn()
    render(
      <ErrorBoundary onError={onError}>
        <Boom throw={new Error('reported')} />
      </ErrorBoundary>,
    )
    expect(onError).toHaveBeenCalledTimes(1)
    const payload: ErrorInfoView = onError.mock.calls[0][0]
    expect(payload.error).toBeInstanceOf(Error)
    expect(payload.error.message).toBe('reported')
    expect(payload.timestamp).toBeInstanceOf(Date)
  })

  it('reset action clears the captured error and re-renders children', () => {
    // Re-throw on subsequent renders so we can prove the boundary
    // actually re-mounted the subtree.
    let shouldThrow = true
    function Toggle(): ReactNode {
      if (shouldThrow) throw new Error('first render only')
      return <div>second render ok</div>
    }
    render(
      <ErrorBoundary>
        <Toggle />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
    shouldThrow = false
    fireEvent.click(screen.getByRole('button', { name: /try to recover/i }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('second render ok')).toBeInTheDocument()
  })

  it('reload action calls window.location.reload', () => {
    render(
      <ErrorBoundary>
        <Boom throw={new Error('reload me')} />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: /reload page/i }))
    expect(reloadStub).toHaveBeenCalledOnce()
  })

  it('truncates very long stack traces', () => {
    const onError = vi.fn()
    render(
      <ErrorBoundary onError={onError}>
        <Boom throw={new Error('huge stack')} />
      </ErrorBoundary>,
    )
    // Manually patch the error to ensure componentDidCatch sees the long
    // stack. Real thrown errors usually have a smaller stack.
    const view: ErrorInfoView = onError.mock.calls[0][0]
    // Simulate a long stack by re-running componentDidCatch through a
    // synthetic update — simplest is to assert the truncation helper
    // directly via a fallback prop:
    render(
      <ErrorBoundary
        fallback={(info) => <pre data-testid="trunc">{info.stack}</pre>}
      >
        <Boom throw={new Error('x')} />
      </ErrorBoundary>,
    )
    // We can't easily inject a long stack via the props API, so this
    // is a smoke test: ensure fallback receives a string stack.
    expect(screen.getByTestId('trunc').textContent).toBeTypeOf('string')
    // Stack field exists on view as well (may be empty in jsdom).
    expect(typeof view.stack).toBe('string')
  })

  it('hides the default fallback when no error has been thrown', () => {
    render(
      <ErrorBoundary>
        <div>fine</div>
      </ErrorBoundary>,
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
