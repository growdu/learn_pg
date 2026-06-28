import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/common/ErrorBoundary'
import './styles/index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary label="learn_pg">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
