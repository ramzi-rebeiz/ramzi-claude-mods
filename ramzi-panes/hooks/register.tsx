import type { Register } from 'claude-code'

import { registerActivity, startActivity } from './activity'
import { registerBranches, startBranches } from './branches'
import { scheduleRefresh } from './refresh'
import { touchesGit } from './shared'
import { registerWorkspace, startFiles } from './workspace'

export const register: Register = on => {
  // One hook per event without a matcher: each pane adds its commands here and
  // registers only the hooks that are its own.
  on('session.start', async ($, e, next) => {
    await startActivity($)
    await startBranches($)
    await startFiles($)
    return next(e)
  })

  registerActivity(on)
  registerBranches(on)
  registerWorkspace(on)

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (touchesGit(e.command)) scheduleRefresh($, 'all')
    return ran
  })
}
