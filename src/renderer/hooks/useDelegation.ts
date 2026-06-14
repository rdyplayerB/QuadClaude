// Delegation surfacing is handled by the Delegation dashboard (chart icon), which shows
// the decision ledger + per-call timeline live (it refreshes on every delegation event).
// We deliberately do NOT auto-pair panes: commandeering a pane on startup is intrusive and
// mis-assigns roles (it grabbed a work pane as the feed). Pairing is user-initiated only
// (pane badge → "Pair with…"). This hook is retired to a no-op but kept for import
// compatibility with App.tsx.
export interface PendingApproval {
  orchestratorId: number
  route: string
  projectName: string
}

export function useDelegation() {
  return { pending: null as PendingApproval | null, approve: () => {}, decline: () => {} }
}
