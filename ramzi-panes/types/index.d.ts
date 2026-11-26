// The values ramzi-panes keeps in $.state: the engine holds them across a hot
// reload, so the panes survive an edit to the mod's code.

/** A tool call still running. */
export type ToolRun = {
  id: string
  tool: string
  label: string
  startedAt: number
  agentId?: string
}

/** A tool call that ended, kept on the turn it ran in. */
export type ToolDone = {
  tool: string
  label: string
  ms: number
  isError: boolean
  agentId?: string
}

/** One main-loop turn: running while `endedAt` is absent, then a ledger entry. */
export type TurnEntry = {
  id: string
  n: number
  prompt: string
  startedAt: number
  endedAt?: number
  reason?: string
  tools: ToolDone[]
  files: string[]
  commits: string[]
  pushes: number
  agents: string[]
}

/** A file an Edit, Write or NotebookEdit call touched, and in which turn. */
export type EditRecord = {
  path: string
  turn: number
  at: number
}

export type ActivityView = {
  collapsed: boolean
  tab: 'now' | 'done'
  open: string | null
}

export type Verdict = 'default' | 'ff' | 'behind' | 'diverged' | 'merged'

export type BranchInfo = {
  name: string
  upstream: string | null
  isCurrent: boolean
  /** Commits on the branch that origin's default branch lacks. */
  ahead: number
  /** Commits on origin's default branch that the branch lacks. */
  behind: number
  /** Commits not yet on the branch's upstream; null without an upstream. */
  unpushed: number | null
  /** Commits on the upstream the local branch lacks; 0 without an upstream. */
  remoteAhead: number
  verdict: Verdict
}

export type RepoBranches = {
  root: string
  label: string
  defaultRef: string
  branches: BranchInfo[]
  fetchedAt: number | null
  error?: string
}

export type BranchesView = {
  collapsed: boolean
  graphs: string[]
  busy: boolean
  at: number | null
}

export type RepoStatus = {
  root: string
  label: string
  branch: string
  /** `git status --porcelain` lines: two status letters, a space, the path. */
  dirty: string[]
}

export type Preview = {
  path: string
  text: string
  isDiff: boolean
}

export type WorkspaceView = {
  collapsed: boolean
  mode: 'changed' | 'tree'
  expanded: string[]
  /** The turn whose edits are highlighted; null highlights every turn's. */
  turn: number | null
  preview: Preview | null
  busy: boolean
  at: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'ramzi-panes': {
      turn: TurnEntry | null
      running: ToolRun[]
      done: TurnEntry[]
      edits: EditRecord[]
      tick: number
      activityView: ActivityView
      repos: string[]
      branches: RepoBranches[]
      branchesView: BranchesView
      status: RepoStatus[]
      workspaceView: WorkspaceView
    }
  }
}
