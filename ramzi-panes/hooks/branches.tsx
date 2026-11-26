import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { BranchInfo, BranchesView, RepoBranches, Verdict } from '../types'
import { clock, cut, ensureRepos, git, repoLabel } from './shared'

export const BRANCHES = 'ramzi-branches'
const OPEN = { id: BRANCHES, title: 'Branches', columns: 64, rows: 12 } as const

const branches = atom({ plugin: 'ramzi-panes', key: 'branches' } as const, [] as RepoBranches[])
const branchesView = atom({ plugin: 'ramzi-panes', key: 'branchesView' } as const, { collapsed: false, graphs: [], busy: false, at: null } as BranchesView)

/** Ramzi's own branches and the view branches rank above a shared clone's other branches. */
const MINE = /-ramzi-\d+$|-view$/
const MAX_BRANCHES = 15

const HEX: Record<Verdict, string> = {
  default: '#58a6ff',
  ff: '#3fb950',
  behind: '#d29922',
  diverged: '#f85149',
  merged: '#8b949e',
}

export function verdictOf(b: { ahead: number; behind: number; unpushed: number | null; remoteAhead: number }, isDefault: boolean): Verdict {
  if (isDefault) return 'default'
  // Local commits the upstream lacks while the upstream has commits the branch lacks: a plain push is refused.
  if ((b.unpushed ?? 0) > 0 && b.remoteAhead > 0) return 'diverged'
  if (b.ahead === 0) return 'merged'
  return b.behind === 0 ? 'ff' : 'behind'
}

export function wordOf(v: Verdict): string {
  switch (v) {
    case 'ff':
      return 'fast-forward of origin'
    case 'behind':
      return 'behind origin, sync owed'
    case 'diverged':
      return 'diverged from its upstream'
    case 'merged':
      return 'merged'
    default:
      return ''
  }
}

export function colorOf(v: Verdict): 'success' | 'warning' | 'error' | 'inactive' | 'suggestion' {
  switch (v) {
    case 'ff':
      return 'success'
    case 'behind':
      return 'warning'
    case 'diverged':
      return 'error'
    case 'merged':
      return 'inactive'
    default:
      return 'suggestion'
  }
}

export function countsOf(b: BranchInfo): string {
  const parts = [`+${b.ahead}`, `−${b.behind}`]
  if ((b.unpushed ?? 0) > 0) parts.push(`↑${b.unpushed}`)
  if (b.remoteAhead > 0) parts.push(`↓${b.remoteAhead}`)
  if (!b.upstream) parts.push('local only')
  return parts.join(' ')
}

/** The default branch's own line: how the local copy stands against origin's. */
export function defaultLine(r: RepoBranches): string {
  const local = r.branches.find(b => b.verdict === 'default')
  if (!local) return r.defaultRef
  if (local.ahead === 0 && local.behind === 0) return `${local.name} = ${r.defaultRef}`
  return `${local.name} ${local.ahead ? `+${local.ahead} unpushed` : ''}${local.ahead && local.behind ? ', ' : ''}${local.behind ? `−${local.behind} behind ${r.defaultRef}` : ''}`
}

async function count($: EngineInterface, root: string, range: string): Promise<number> {
  const out = await git($, root, ['rev-list', '--count', range])
  return out ? Number.parseInt(out, 10) || 0 : 0
}

async function defaultRefOf($: EngineInterface, root: string): Promise<string | null> {
  const head = await git($, root, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])
  if (head?.trim()) return head.trim()
  for (const c of ['origin/master', 'origin/main', 'master', 'main']) {
    if ((await git($, root, ['rev-parse', '--verify', '-q', `${c}^{commit}`])) !== null) return c
  }
  return null
}

async function fetchedAtOf($: EngineInterface, root: string): Promise<number | null> {
  const common = (await git($, root, ['rev-parse', '--git-common-dir']))?.trim()
  if (!common) return null
  const dir = common.startsWith('/') ? common : `${root}/${common}`
  try {
    const st = (await $.fs.stat(`${dir}/FETCH_HEAD`)) as { mtimeMs?: number }
    return typeof st.mtimeMs === 'number' && st.mtimeMs > 0 ? st.mtimeMs : null
  } catch {
    return null
  }
}

export async function readBranches($: EngineInterface, root: string): Promise<RepoBranches> {
  const label = repoLabel(root)
  const fetchedAt = await fetchedAtOf($, root)
  const defaultRef = await defaultRefOf($, root)
  if (!defaultRef) return { root, label, defaultRef: '?', branches: [], fetchedAt, error: 'no default branch found (origin/HEAD, master or main)' }
  const listed = await git($, root, ['for-each-ref', '--format=%(refname:short)%09%(upstream:short)%09%(HEAD)', 'refs/heads'])
  if (listed === null) return { root, label, defaultRef, branches: [], fetchedAt, error: 'git for-each-ref failed' }
  const defaultLocal = defaultRef.replace(/^origin\//, '')
  const rows = listed
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [name = '', upstream = '', head = ''] = line.split('\t')
      return { name, upstream: upstream || null, isCurrent: head === '*' }
    })
  const rank = (r: { name: string; isCurrent: boolean }) => (r.isCurrent ? 0 : r.name === defaultLocal ? 1 : MINE.test(r.name) ? 2 : 3)
  rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  const out: BranchInfo[] = []
  for (const r of rows.slice(0, MAX_BRANCHES)) {
    const leftRight = await git($, root, ['rev-list', '--left-right', '--count', `${defaultRef}...${r.name}`])
    const [behind = 0, ahead = 0] = (leftRight ?? '0\t0')
      .trim()
      .split(/\s+/)
      .map(n => Number.parseInt(n, 10) || 0)
    const unpushed = r.upstream ? await count($, root, `${r.upstream}..${r.name}`) : null
    const remoteAhead = r.upstream ? await count($, root, `${r.name}..${r.upstream}`) : 0
    const counts = { ahead, behind, unpushed, remoteAhead }
    out.push({ name: r.name, upstream: r.upstream, isCurrent: r.isCurrent, ...counts, verdict: verdictOf(counts, r.name === defaultLocal) })
  }
  return { root, label, defaultRef, branches: out, fetchedAt }
}

export async function refreshBranches($: EngineInterface, rediscover = false): Promise<void> {
  await update($, branchesView, v => ({ ...v, busy: true }))
  try {
    const roots = await ensureRepos($, rediscover)
    const out = await Promise.all(roots.map(root => readBranches($, root)))
    const now = await $.clock.now()
    await update($, branches, () => out)
    await update($, branchesView, v => ({ ...v, busy: false, at: now }))
  } catch {
    await update($, branchesView, v => ({ ...v, busy: false }))
  }
}

export async function openBranches($: EngineInterface, focus = false): Promise<boolean> {
  const opened = await $.ui.open(focus ? { ...OPEN, focus: true } : OPEN)
  void refreshBranches($)
  return opened.isPlaced
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * The repo's branches as a lane graph: origin's default branch is the top
 * line, each other branch forks from it as far left as it is behind, carries a
 * dot per commit ahead, and ends in its verdict's colour. Labels sit in a
 * column of their own on the left so no line runs under text.
 */
export function graphSvg(r: RepoBranches, width: number): string {
  const rows = r.branches.filter(b => b.verdict !== 'default')
  const rowH = 20
  const height = 24 + rows.length * rowH
  const labelW = Math.min(300, Math.round(width * 0.55))
  const x0 = labelW + 8
  const x1 = width - 10
  const baseY = 14
  const maxBehind = Math.max(1, ...rows.map(b => b.behind))
  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11">`)
  parts.push(`<text x="4" y="${baseY + 4}" fill="${HEX.default}">${esc(cut(defaultLine(r), 40))}</text>`)
  parts.push(`<line x1="${x0}" y1="${baseY}" x2="${x1}" y2="${baseY}" stroke="${HEX.default}" stroke-width="2"/>`)
  parts.push(`<circle cx="${x1 - 3}" cy="${baseY}" r="3.5" fill="${HEX.default}"/>`)
  rows.forEach((b, i) => {
    const y = baseY + rowH * (i + 1)
    const c = HEX[b.verdict]
    const span = x1 - x0 - 24
    const fork = x1 - 24 - Math.round(span * Math.min(1, b.behind / maxBehind))
    parts.push(`<path d="M ${fork} ${baseY} C ${fork + 8} ${baseY}, ${fork + 8} ${y}, ${fork + 16} ${y} L ${x1 - 3} ${y}" fill="none" stroke="${c}" stroke-width="2"/>`)
    const dots = Math.min(b.ahead, 6)
    for (let k = 0; k < dots; k++) {
      const cx = x1 - 3 - k * 9
      if (cx > fork + 16) parts.push(`<circle cx="${cx}" cy="${y}" r="3" fill="${c}"/>`)
    }
    const label = `${b.isCurrent ? '* ' : ''}${b.name}  ${countsOf(b)}`
    parts.push(`<text x="4" y="${y + 4}" fill="${c}">${esc(cut(label, 44))}</text>`)
    parts.push(`<title>${esc(`${b.name}: ${wordOf(b.verdict)} (${countsOf(b)})`)}</title>`)
  })
  parts.push('</svg>')
  return parts.join('')
}

export function textOf(r: RepoBranches): string {
  return [`${r.label}: ${defaultLine(r)}`, ...r.branches.filter(b => b.verdict !== 'default').map(b => `${b.isCurrent ? '* ' : ''}${b.name} ${countsOf(b)} ${wordOf(b.verdict)}`)].join('\n')
}

export async function startBranches($: EngineInterface): Promise<void> {
  await $.command.register({ name: 'branches', description: "Open the Branches pane: every repo's branches against origin's default branch, with a fast-forward verdict and a graph" })
}

export function registerBranches(on: On): void {
  on('command.run', { command: 'branches' }, async $ => {
    const placed = await openBranches($, true)
    return { text: placed ? 'Branches pane open; reading every repo.' : 'Branches pane is open but this surface does not draw panes.' }
  })

  on('ui.render', { component: 'Pane', requestId: BRANCHES }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [list, v] = await Promise.all([read($, branches), read($, branchesView)])
    const cols = Math.max(30, e.props.bodyColumns)
    const set = (patch: Partial<typeof v>) => update($, branchesView, cur => ({ ...cur, ...patch }))
    const withWork = list.filter(r => r.error || r.branches.some(b => b.verdict !== 'default'))
    const quiet = list.filter(r => !withWork.includes(r))
    const head = v.busy ? `${list.length || '…'} repos · refreshing…` : v.at ? `${list.length} repos · as of ${clock(v.at)}` : 'not read yet'
    const graphOf = (r: RepoBranches) => {
      if (e.surface === 'terminal') return null
      const { Svg } = $.ui.resolve(e)
      return <Svg source={graphSvg(r, Math.min(640, Math.max(280, cols * 7)))} alt={textOf(r)} />
    }
    const linesOf = (r: RepoBranches) =>
      r.branches
        .filter(b => b.verdict !== 'default')
        .map(b => (
          <Text color={colorOf(b.verdict)}>{cut(`   ${b.isCurrent ? '*' : '●'} ${b.name}  ${countsOf(b)}  ${wordOf(b.verdict)}`, cols - 1)}</Text>
        ))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Button key="collapse" plain onPress={() => set({ collapsed: !v.collapsed })}>
            {v.collapsed ? '▸' : '▾'}
          </Button>
          <Text weight="semibold">{`⎇ ${cut(head, cols - 10)}`}</Text>
          <Button key="refresh" plain dimColor onPress={() => refreshBranches($, true)}>
            ↻
          </Button>
        </Box>
        {!v.collapsed && (
          <Box flexDirection="column">
            {list.length === 0 && !v.busy && <Text dimColor>Press ↻ to read the repos.</Text>}
            {withWork.map(r => (
              <Box flexDirection="column">
                <Button key={`repo-${r.root}`} plain onPress={() => set({ graphs: v.graphs.includes(r.root) ? v.graphs.filter(x => x !== r.root) : [...v.graphs, r.root] })}>
                  {`${v.graphs.includes(r.root) ? '▾' : '▸'} ${r.label}`}
                  <Text dimColor>{cut(`  ${defaultLine(r)}${r.fetchedAt ? ` · fetched ${clock(r.fetchedAt)}` : ''}`, cols - r.label.length - 4)}</Text>
                </Button>
                {r.error && <Text color="error">{`   ${cut(r.error, cols - 4)}`}</Text>}
                {v.graphs.includes(r.root) && e.surface !== 'terminal' ? graphOf(r) : linesOf(r)}
              </Box>
            ))}
            {quiet.length > 0 && <Text dimColor>{cut(`default branch only: ${quiet.map(r => r.label).join(', ')}`, cols - 1)}</Text>}
            <Text dimColor>
              <Text color="success">● fast-forward</Text>
              {'  '}
              <Text color="warning">● behind, sync owed</Text>
              {'  '}
              <Text color="error">● diverged</Text>
              {'  '}
              <Text color="inactive">● merged</Text>
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}
