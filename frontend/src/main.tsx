import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/common/ErrorBoundary'
import { installGlobalErrorHandlers, reportError } from './lib/errorReporter'
import { installWebVitals } from './lib/webVitals'
import './styles/index.css'

// Install telemetry before React mounts so we capture errors that
// happen during initialization too.
installGlobalErrorHandlers()
installWebVitals()

// Forward boundary captures to the global reporter. ErrorBoundary
// already shows a fallback UI; this gives us a structured report
// alongside it.
window.addEventListener('learn_pg:boundary', (event) => {
  const detail = (event as CustomEvent).detail as { error: unknown; info: unknown }
  reportError({ error: detail.error, source: 'boundary', context: { info: detail.info } })
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary label="learn_pg">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
