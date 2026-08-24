import { Component, ErrorInfo, ReactNode } from 'react'
import { useWorkspaceStore } from '../store/workspace'
import { Sidebar } from './Sidebar'

// The pane list is a convenience; the terminals are the app. React unmounts the
// entire tree when a render throws, so without this a bug in one sidebar row
// would take down all nine terminals — the same failure OpsOverlay already
// guards against when it mounts the console. On a throw we close the sidebar and
// leave everything else standing.
class Boundary extends Component<{ children: ReactNode; onError: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[sidebar] render failed — closing it rather than taking down the terminals', error, info.componentStack)
    this.props.onError()
  }
  render() { return this.state.failed ? null : this.props.children }
}

export function SidebarSafe() {
  const setSidebarOpen = useWorkspaceStore((s) => s.setSidebarOpen)
  return (
    <Boundary onError={() => setSidebarOpen(false)}>
      <Sidebar />
    </Boundary>
  )
}
