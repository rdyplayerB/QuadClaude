import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { startPerfReporter } from './perf'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// Begin reporting renderer-side performance metrics to the main process.
startPerfReporter()
