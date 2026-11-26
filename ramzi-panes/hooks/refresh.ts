import type { EngineInterface, Timer } from 'claude-code'

import { BRANCHES, refreshBranches } from './branches'
import { FILES, refreshStatus } from './workspace'

/**
 * The git-reading panes refresh themselves a moment after a Bash command that
 * names git ends, and when a turn ends; one timer folds a burst of commands
 * into one read. Only an open pane is read.
 */
let pending: Timer | null = null

export function scheduleRefresh($: EngineInterface, what: 'all' | 'status'): void {
  pending?.cancel()
  pending = $.clock.after(1500, () => {
    pending = null
    void (async () => {
      const open = new Set((await $.ui.panes()).map(p => p.id))
      if (open.has(FILES)) await refreshStatus($)
      if (what === 'all' && open.has(BRANCHES)) await refreshBranches($)
    })()
  })
}
