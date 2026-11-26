import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement } from 'claude-code'

import type { RepoStatus, WorkspaceView } from '../types'
import { clock, cut, ensureRepos, git, readEdits, readRepos, readTurn, repoLabel, repoOf, short } from './shared'

export const FILES = 'ramzi-files'
const OPEN = { id: FILES, title: 'Files', columns: 54, rows: 14 } as const

const status = atom({ plugin: 'ramzi-panes', key: 'status' } as const, [] as RepoStatus[])
const workspaceView = atom({ plugin: 'ramzi-panes', key: 'workspaceView' } as const, {
  collapsed: false,
  mode: 'changed',
  expanded: [],
  turn: null,
  preview: null,
  busy: false,
  at: null,
} as WorkspaceView)
const HIDE = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache', '.ruff_cache', 'dist', 'build'])
const MAX_ROWS = 160

type Mark = { code: string; turns: number[] }

/** `XY path` of `git status --porcelain`, the new name of a rename, quotes stripped. */
export function parsePorcelain(line: string): { code: string; path: string } | null {
  if (line.length < 4) return null
  const code = line.slice(0, 2)
  let path = line.slice(3)
  const arrow = path.indexOf(' -> ')
  if (arrow >= 0) path = path.slice(arrow + 4)
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)
  return { code, path }
}

export async function refreshStatus($: EngineInterface, rediscover = false): Promise<void> {
  await update($, workspaceView, v => ({ ...v, busy: true }))
  try {
    const roots = await ensureRepos($, rediscover)
    const out: RepoStatus[] = await Promise.all(
      roots.map(async root => {
        const branch = (await git($, root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() ?? '?'
        const porcelain = await git($, root, ['status', '--porcelain', '-unormal'])
        return { root, label: repoLabel(root), branch, dirty: (porcelain ?? '').split('\n').filter(Boolean).slice(0, 200) }
      }),
    )
    const now = await $.clock.now()
    await update($, status, () => out)
    await update($, workspaceView, v => ({ ...v, busy: false, at: now }))
  } catch {
    await update($, workspaceView, v => ({ ...v, busy: false }))
  }
}

export async function openFiles($: EngineInterface, focus = false): Promise<boolean> {
  const opened = await $.ui.open(focus ? { ...OPEN, focus: true } : OPEN)
  void refreshStatus($)
  return opened.isPlaced
}

async function openPreview($: EngineInterface, root: string | null, path: string): Promise<void> {
  let text: string | null = null
  let isDiff = false
  if (root) {
    const rel = path.slice(root.length + 1)
    const diff = (await git($, root, ['diff', '--', rel])) || (await git($, root, ['diff', '--cached', '--', rel]))
    if (diff) {
      text = diff
      isDiff = true
    }
  }
  if (text === null) {
    try {
      text = (await $.fs.read(path)).split('\n').slice(0, 80).join('\n')
    } catch {
      text = '(cannot read this file)'
    }
  }
  await update($, workspaceView, v => ({ ...v, preview: { path, text: text.slice(0, 20_000), isDiff } }))
}

export async function startFiles($: EngineInterface): Promise<void> {
  await $.command.register({ name: 'files', description: 'Open the Files pane: every repo as a tree, files coloured by the turn that edited them, with git status and a diff on press' })
}

export function registerWorkspace(on: On): void {
  on('command.run', { command: 'files' }, async $ => {
    const placed = await openFiles($, true)
    return { text: placed ? 'Files pane open; reading git status of every repo.' : 'Files pane is open but this surface does not draw panes.' }
  })

  on('ui.render', { component: 'Pane', requestId: FILES }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const [list, v, eds, t, roots] = await Promise.all([read($, status), read($, workspaceView), readEdits($), readTurn($), readRepos($)])
    const cols = Math.max(30, e.props.bodyColumns)
    const set = (patch: Partial<WorkspaceView>) => update($, workspaceView, cur => ({ ...cur, ...patch }))
    const currentTurn = t?.n ?? 0
    const head = v.busy ? 'refreshing…' : v.at ? `${list.length} repos · as of ${clock(v.at)}` : 'not read yet'

    // One mark per absolute path: its git status code and the turns that edited it this session.
    const marks = new Map<string, Mark>()
    for (const s of list) {
      for (const line of s.dirty) {
        const p = parsePorcelain(line)
        if (p) marks.set(`${s.root}/${p.path}`, { code: p.code, turns: [] })
      }
    }
    for (const x of eds) {
      const m = marks.get(x.path) ?? { code: '', turns: [] }
      if (!m.turns.includes(x.turn)) m.turns.push(x.turn)
      marks.set(x.path, m)
    }
    const colorFor = (m: Mark | undefined): 'success' | 'warning' | 'text' => {
      if (!m || m.turns.length === 0) return 'text'
      const hit = v.turn === null ? true : m.turns.includes(v.turn)
      return hit ? 'success' : 'warning'
    }
    const rowOf = (abs: string, root: string | null, label: string, indent: string) => {
      const m = marks.get(abs)
      const code = m?.code.trim() || (m?.turns.length ? '✎' : ' ')
      return (
        <Button key={`f-${abs}`} plain onPress={() => openPreview($, root, abs)}>
          <Text color={colorFor(m)} weight={m?.turns.length ? 'semibold' : 'regular'}>
            {cut(`${indent}${code.padEnd(2)} ${label}`, cols - 1)}
          </Text>
        </Button>
      )
    }
    const toggle = (key: string) => set({ expanded: v.expanded.includes(key) ? v.expanded.filter(x => x !== key) : [...v.expanded, key] })

    let rows = 0
    const changedOf = (s: RepoStatus) => {
      const paths = [...marks.keys()].filter(p => repoOf(p, roots) === s.root).sort()
      return paths.slice(0, 60).map(abs => {
        rows += 1
        return rowOf(abs, s.root, abs.slice(s.root.length + 1), '  ')
      })
    }
    const treeOf = async (dir: string, root: string, depth: number): Promise<RenderElement[]> => {
      if (rows > MAX_ROWS || depth > 8) return []
      let entries
      try {
        entries = await $.fs.list(dir)
      } catch {
        return []
      }
      const kept = entries.filter(x => !HIDE.has(x.name) && !x.name.startsWith('.')).sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name))
      const out: RenderElement[] = []
      for (const x of kept) {
        if (rows > MAX_ROWS) break
        const abs = `${dir}/${x.name}`
        const indent = '  '.repeat(depth + 1)
        rows += 1
        if (x.kind === 'dir') {
          const open = v.expanded.includes(abs)
          out.push(
            <Button key={`d-${abs}`} plain onPress={() => toggle(abs)}>
              {`${indent}${open ? '▾' : '▸'} ${x.name}/`}
            </Button>,
          )
          if (open) out.push(...(await treeOf(abs, root, depth + 1)))
        } else {
          out.push(rowOf(abs, root, x.name, indent))
        }
      }
      return out
    }

    const sorted = [...list].sort((a, b) => a.label.localeCompare(b.label))
    const sections: RenderElement[] = []
    const clean: string[] = []
    for (const s of sorted) {
      const changed = [...marks.keys()].filter(p => repoOf(p, roots) === s.root).length
      if (v.mode === 'changed' && changed === 0) {
        clean.push(s.label)
        continue
      }
      const open = v.mode === 'changed' ? !v.expanded.includes(`!${s.root}`) : v.expanded.includes(s.root)
      sections.push(
        <Box flexDirection="column">
          <Button key={`repo-${s.root}`} plain onPress={() => toggle(v.mode === 'changed' ? `!${s.root}` : s.root)}>
            {`${open ? '▾' : '▸'} ${s.label}`}
            <Text dimColor>{cut(`  ${s.branch}${changed ? ` · ${changed} changed` : ''}`, cols - s.label.length - 4)}</Text>
          </Button>
          {open && (v.mode === 'changed' ? changedOf(s) : await treeOf(s.root, s.root, 0))}
        </Box>,
      )
    }
    const outside = [...marks.keys()].filter(p => repoOf(p, roots) === null).sort()

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Button key="collapse" plain onPress={() => set({ collapsed: !v.collapsed })}>
            {v.collapsed ? '▸' : '▾'}
          </Button>
          <Text weight="semibold">{`⌂ ${cut(head, cols - 10)}`}</Text>
          <Button key="refresh" plain dimColor onPress={() => refreshStatus($, true)}>
            ↻
          </Button>
        </Box>
        {!v.collapsed && (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Button key="mode-changed" plain dimColor={v.mode !== 'changed'} onPress={() => set({ mode: 'changed' })}>
                changed
              </Button>
              <Button key="mode-tree" plain dimColor={v.mode !== 'tree'} onPress={() => set({ mode: 'tree' })}>
                tree
              </Button>
              <Text dimColor>{' · turn'}</Text>
              <Button key="turn-prev" plain dimColor onPress={() => set({ turn: Math.max(1, (v.turn ?? currentTurn) - 1) })}>
                ◀
              </Button>
              <Button key="turn-all" plain dimColor={v.turn !== null} onPress={() => set({ turn: v.turn === null ? currentTurn : null })}>
                {v.turn === null ? 'all' : String(v.turn)}
              </Button>
              <Button key="turn-next" plain dimColor onPress={() => set({ turn: Math.min(currentTurn, (v.turn ?? currentTurn) + 1) })}>
                ▶
              </Button>
            </Box>
            {v.preview && (
              <Box flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Button key="preview-close" plain onPress={() => set({ preview: null })}>
                    ✕
                  </Button>
                  <Text weight="semibold">{cut(short(v.preview.path), cols - 4)}</Text>
                </Box>
                {v.preview.isDiff ? <Code source={v.preview.text} format="diff" path={v.preview.path} /> : <Code source={v.preview.text} path={v.preview.path} />}
              </Box>
            )}
            {list.length === 0 && !v.busy && <Text dimColor>Press ↻ to read the repos.</Text>}
            {sections}
            {outside.length > 0 && (
              <Box flexDirection="column">
                <Text dimColor>outside any repo</Text>
                {outside.slice(0, 20).map(abs => rowOf(abs, null, short(abs), '  '))}
              </Box>
            )}
            {v.mode === 'changed' && clean.length > 0 && <Text dimColor>{cut(`clean: ${clean.join(', ')}`, cols - 1)}</Text>}
            <Text dimColor>
              <Text color="success">■ edited in the shown turn</Text>
              {'  '}
              <Text color="warning">■ edited in another turn</Text>
              {'  M/?? git status'}
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}
