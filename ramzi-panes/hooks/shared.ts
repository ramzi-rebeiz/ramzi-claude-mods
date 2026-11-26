import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { EditRecord, TurnEntry } from '../types'

export const PLUGIN = 'ramzi-panes'

// Every value lives in $.state so the engine keeps it across a hot reload; the
// module's own variables (timers, debounces) start over on each reload. The
// validator reads each atom only in the module that declares it, so the three
// values two panes share are reached through these functions, and each pane
// declares the atoms that are its own.
const turn = atom({ plugin: 'ramzi-panes', key: 'turn' } as const, null as TurnEntry | null)
const edits = atom({ plugin: 'ramzi-panes', key: 'edits' } as const, [] as EditRecord[])
const repos = atom({ plugin: 'ramzi-panes', key: 'repos' } as const, [] as string[])

// Function declarations, not arrow functions: the validator follows `$` from
// another file only into a declaration.
export function readTurn($: EngineInterface): Promise<TurnEntry | null> {
  return read($, turn)
}
export function setTurn($: EngineInterface, fn: (t: TurnEntry | null) => TurnEntry | null): Promise<TurnEntry | null> {
  return update($, turn, fn)
}
export function readEdits($: EngineInterface): Promise<EditRecord[]> {
  return read($, edits)
}
export function addEdits($: EngineInterface, fresh: EditRecord[]): Promise<EditRecord[]> {
  return update($, edits, list => [...list, ...fresh].slice(-500))
}
export function readRepos($: EngineInterface): Promise<string[]> {
  return read($, repos)
}

/** The repo list, discovered on first use and kept for the session; ↻ in a pane rediscovers. */
export async function ensureRepos($: EngineInterface, rediscover = false): Promise<string[]> {
  let roots = await read($, repos)
  if (roots.length === 0 || rediscover) {
    roots = await discoverRepos($)
    await update($, repos, () => roots)
  }
  return roots
}

export function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? p : p.slice(i + 1)
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

/** `~/console/c4/src` reads as `c4/src` and `~/worktrees/x` as `worktrees/x`, so two clones of one repo tell apart. */
export function repoLabel(root: string): string {
  const name = basename(root)
  const parent = basename(dirname(root))
  return name === 'src' || parent === 'worktrees' ? `${parent}/${name}` : name
}

/** A path with the home directory folded to `~`, whichever user's it is. */
export function short(path: string): string {
  return path.replace(/^\/(?:home|Users)\/[^/]+\//, '~/')
}

export function cut(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, Math.max(0, max - 1))}…`
}

export function fmtMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function uniq(list: string[]): string[] {
  return [...new Set(list)]
}

/** Runs git in `cwd`; null on any failure, so a caller never throws over one repo. */
export async function git($: EngineInterface, cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const ran = await $.process.run(['git', '--no-optional-locks', ...args], { cwd, timeoutMs: 20_000 })
    return ran.exitCode === 0 ? ran.stdout : null
  } catch {
    return null
  }
}

const SKIP_DIRS = new Set(['node_modules', 'venv', '.venv', 'dist', 'build'])

/**
 * Every git checkout the session can see: the session's root and its parent
 * (a cloud container keeps sibling repos there), the home directory, and the
 * dev host's two nests, `~/console/<x>/src` and `~/worktrees/<branch>`.
 * Two levels below each seed is as deep as it looks.
 */
export async function discoverRepos($: EngineInterface): Promise<string[]> {
  const home = (await $.env.get('HOME')) ?? ''
  const root = await $.session.root()
  const seeds = uniq([root, dirname(root), home, `${home}/console`, `${home}/worktrees`].filter(p => p && p !== '/'))
  const found = new Set<string>()
  const isRepo = (p: string) => $.fs.exists(`${p}/.git`)
  const listDirs = async (p: string) => {
    try {
      return (await $.fs.list(p)).filter(e => e.kind === 'dir' && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
    } catch {
      return []
    }
  }
  for (const seed of seeds) {
    if (await isRepo(seed)) found.add(seed)
    for (const d of await listDirs(seed)) {
      const p = `${seed}/${d.name}`
      if (found.has(p)) continue
      if (await isRepo(p)) {
        found.add(p)
        continue
      }
      for (const s of await listDirs(p)) {
        const q = `${p}/${s.name}`
        if (await isRepo(q)) found.add(q)
      }
    }
    if (found.size > 40) break
  }
  return [...found].sort()
}

/** The repo in `roots` that holds `path`, the deepest when one is nested in another. */
export function repoOf(path: string, roots: readonly string[]): string | null {
  let best: string | null = null
  for (const r of roots) if (path === r || path.startsWith(`${r}/`)) if (!best || r.length > best.length) best = r
  return best
}

export function gitKindsOf(command: string): Set<'commit' | 'push'> {
  const kinds = new Set<'commit' | 'push'>()
  // Each simple command of a chain is read on its own, so `git add x && git commit` counts one commit.
  for (const part of command.split(/&&|\|\||;|\n/)) {
    if (/\bgit\b[^|]*\bcommit\b/.test(part)) kinds.add('commit')
    if (/\bgit\b[^|]*\bpush\b/.test(part)) kinds.add('push')
  }
  return kinds
}

export function commitSubject(command: string): string {
  const m = /-m\s+(?:"([^"\n]*)|'([^'\n]*)|\$'([^'\n]*))/.exec(command)
  const subject = (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim()
  return subject || 'commit'
}

export function touchesGit(command: string): boolean {
  return /\bgit\b/.test(command) || /\bgh\s+pr\s+merge\b/.test(command)
}
