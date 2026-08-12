import { ServerInfo } from '../../shared/types'

// Which of a pane's listening ports is the one you'd actually open.
//
// `command` can't answer this: it comes from `lsof -Fc`, which reports the
// process NAME, so a Vite frontend and an Express backend both say "node". The
// port number can. macOS allocates ephemeral ports from 49152 up, so anything at
// or above that line is a socket something opened on its way somewhere — an HMR
// channel, a debugger, a worker — never a URL you would type. The app port is
// the lowest port below that line; if a pane somehow has nothing but ephemeral
// ports, the lowest is still the best guess on offer.
//
// Pure and separate from the header so it can be checked against real port sets
// without mounting a component.
export const EPHEMERAL_PORT_MIN = 49152

export function splitServers(servers: ServerInfo[]): { primary: ServerInfo | null; rest: ServerInfo[] } {
  if (servers.length === 0) return { primary: null, rest: [] }
  const byPort = [...servers].sort((a, b) => a.port - b.port)
  const primary = byPort.find((s) => s.port < EPHEMERAL_PORT_MIN) ?? byPort[0]
  return { primary, rest: byPort.filter((s) => s !== primary) }
}
