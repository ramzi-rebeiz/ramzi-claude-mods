import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Timer, ToolCallInput, ToolCallResult } from 'claude-code'

import type { ActivityView, EditRecord, ToolDone, ToolRun, TurnEntry } from '../types'
import { openBranches } from './branches'
import { scheduleRefresh } from './refresh'
import { addEdits, clock, commitSubject, cut, fmtMs, gitKindsOf, readTurn, setTurn, short } from './shared'
import { openFiles } from './workspace'

export const ACTIVITY = 'ramzi-activity'
const OPEN = { id: ACTIVITY, title: 'Activity', columns: 46, rows: 9 } as const

const running = atom({ plugin: 'ramzi-panes', key: 'running' } as const, [] as ToolRun[])
const done = atom({ plugin: 'ramzi-panes', key: 'done' } as const, [] as TurnEntry[])
const tick = atom({ plugin: 'ramzi-panes', key: 'tick' } as const, 0)
const activityView = atom({ plugin: 'ramzi-panes', key: 'activityView' } as const, { collapsed: false, tab: 'now', open: null } as ActivityView)

/**
 * One ticker per loaded module, alive only while a main-loop turn runs: its
 * write to `tick` is what redraws the elapsed times every second.
 */
let ticker: Timer | null = null

function startTicker($: EngineInterface): void {
  if (ticker) return
  ticker = $.clock.every(1000, () => {
    void (async () => {
      await update($, tick, n => n + 1)
      const [t, runs, now, n] = await Promise.all([readTurn($), read($, running), $.clock.now(), read($, tick)])
      if (!t || t.endedAt !== undefined) return
      const last = runs[runs.length - 1]
      const line = `⟳ ${fmtMs(now - t.startedAt)} · ${last ? cut(last.label, 60) : 'thinking…'}`
      $.ui.status(line)
      if (n % HEARTBEAT_S === 0 && (await hasNoSurface($))) await notice($, `${line} · ${t.tools.length} calls done`)
    })()
  })
}

function stopTicker(): void {
  ticker?.cancel()
  ticker = null
}

/** The one line a tool call shows as: what the model said it was doing, else what it called. */
export function labelOf(e: ToolCallInput): string {
  const x = e as unknown as Record<string, unknown>
  const s = (k: string) => (typeof x[k] === 'string' ? (x[k] as string) : '')
  const tool: string = e.tool
  switch (tool) {
    case 'Bash':
      return s('description') || cut(s('command').split('\n')[0] ?? '', 80)
    case 'Agent':
      return `Agent · ${s('description') || cut(s('prompt'), 50)}`
    case 'Edit':
    case 'Write':
    case 'Read':
      return `${tool} ${short(s('file_path'))}`
    case 'NotebookEdit':
      return `${tool} ${short(s('notebook_path'))}`
    case 'Grep':
    case 'Glob':
      return `${tool} ${s('pattern')}`
    case 'Skill':
      return `Skill ${s('skill')}`
    case 'WebFetch':
      return `Fetch ${s('url')}`
    case 'WebSearch':
    case 'ToolSearch':
      return `${tool} ${s('query')}`
    case 'TaskCreate':
    case 'TaskUpdate':
      return `${tool} ${s('subject') || s('status')}`
    default:
      return tool.startsWith('mcp__') ? tool.slice(5).replace(/__/g, ' · ') : `${tool}${s('description') ? ` ${s('description')}` : ''}`
  }
}

function filesOf(e: ToolCallInput): string[] {
  const x = e as unknown as Record<string, unknown>
  const tool: string = e.tool
  const p = tool === 'NotebookEdit' ? x['notebook_path'] : tool === 'Edit' || tool === 'Write' ? x['file_path'] : undefined
  return typeof p === 'string' && p ? [p] : []
}

export function entryLine(t: TurnEntry, max: number): string {
  const parts = [
    `${clock(t.startedAt)}`,
    fmtMs((t.endedAt ?? t.startedAt) - t.startedAt),
    `${t.tools.length} tools`,
    ...(t.files.length ? [`${t.files.length} files`] : []),
    ...(t.commits.length ? [`${t.commits.length} commit${t.commits.length > 1 ? 's' : ''}`] : []),
    ...(t.pushes ? [`${t.pushes} push${t.pushes > 1 ? 'es' : ''}`] : []),
    ...(t.reason && t.reason !== 'answer' ? [t.reason] : []),
  ]
  const head = parts.join(' · ')
  return `${head} · ${cut(t.prompt || '(continued)', Math.max(12, max - head.length - 3))}`
}

/** At session start and at every reload: the commands, the ticker if a turn is mid-flight, and the pane itself. */
export async function startActivity($: EngineInterface): Promise<void> {
  await $.command.register({ name: 'activity', description: 'Open the Activity pane: what Claude is doing now, and the ledger of finished turns' })
  await $.command.register({ name: 'done', description: 'List the finished turns of this session as text: /done 20 for the last twenty' })
  const t = await readTurn($)
  if (t && t.endedAt === undefined) startTicker($)
  void $.ui.open(OPEN)
}

/**
 * A Remote Control session attaches no surface, so no pane, band or status
 * line can draw there; the transcript still reaches the phone. There, and only
 * there, the mod appends a notice row: a heartbeat while a long turn runs and
 * a summary when a turn ends.
 */
async function hasNoSurface($: EngineInterface): Promise<boolean> {
  try {
    return (await $.session.surfaces()).length === 0
  } catch {
    return false
  }
}

async function notice($: EngineInterface, text: string): Promise<void> {
  try {
    await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } })
  } catch {
    // A session that takes no plugin rows simply shows nothing.
  }
}

const HEARTBEAT_S = 120

export function registerActivity(on: On): void {
  on('command.run', { command: 'activity' }, async $ => {
    const opened = await $.ui.open({ ...OPEN, focus: true })
    return {
      text: opened.isPlaced
        ? 'Activity pane open.'
        : `Activity pane is open but not drawn here (${opened.reason}); the band above the prompt shows the same while a turn runs.`,
    }
  })

  on('command.run', { command: 'done' }, async ($, e) => {
    const list = await read($, done)
    const n = Number.parseInt(e.args, 10)
    const shown = list.slice(-(Number.isFinite(n) && n > 0 ? n : 10))
    return { text: shown.length ? shown.map(t => entryLine(t, 160)).join('\n') : 'No finished turns yet.' }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const [list, now] = await Promise.all([read($, done), $.clock.now()])
    const fresh: TurnEntry = { id: e.turnId, n: list.length + 1, prompt: e.text, startedAt: now, tools: [], files: [], commits: [], pushes: 0, agents: [] }
    await setTurn($, () => fresh)
    await update($, running, () => [])
    startTicker($)
    $.ui.status(`⟳ working · ${cut(e.text, 60)}`)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const started = await $.clock.now()
    const label = labelOf(e)
    const run: ToolRun = { id: e.tool_use_id, tool: e.tool, label, startedAt: started, ...(e.agentId !== undefined ? { agentId: e.agentId } : {}) }
    await update($, running, list => [...list, run].slice(-60))
    const files = filesOf(e)
    if (files.length) {
      const t = await readTurn($)
      const fresh: EditRecord[] = files.map(path => ({ path, turn: t?.n ?? 0, at: started }))
      await addEdits($, fresh)
    }
    let ran: ToolCallResult | undefined
    try {
      ran = await next(e)
      return ran
    } finally {
      const ended = await $.clock.now()
      const isError = ran === undefined || ran.deny !== undefined || ran.isError === true
      const one: ToolDone = { tool: e.tool, label, ms: ended - started, isError, ...(run.agentId ? { agentId: run.agentId } : {}) }
      const kinds = e.tool === 'Bash' && !isError ? gitKindsOf(e.command) : new Set<string>()
      const subject = e.tool === 'Bash' ? commitSubject(e.command) : ''
      await update($, running, list => list.filter(r => r.id !== run.id))
      await setTurn($, t =>
        t && t.endedAt === undefined
          ? {
              ...t,
              tools: [...t.tools, one].slice(-300),
              files: [...new Set([...t.files, ...files])],
              commits: kinds.has('commit') ? [...t.commits, subject] : t.commits,
              pushes: t.pushes + (kinds.has('push') ? 1 : 0),
              agents: e.tool === 'Agent' ? [...t.agents, label] : t.agents,
            }
          : t,
      )
    }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const answered = await next(e)
    const [now, t] = await Promise.all([$.clock.now(), readTurn($)])
    if (t && t.endedAt === undefined) {
      const finished: TurnEntry = { ...t, endedAt: now, reason: e.reason }
      await setTurn($, () => finished)
      await update($, done, list => [...list, finished].slice(-100))
      await update($, running, () => [])
      try {
        // Across sessions too, so yesterday's ledger can still be read; the newest 200 turns.
        const prev = ((await $.store.get('ledger')) as TurnEntry[] | undefined) ?? []
        await $.store.set('ledger', [...prev, finished].slice(-200))
      } catch {
        // The store is a convenience; the pane never depends on it.
      }
    }
    stopTicker()
    scheduleRefresh($, 'status')
    $.ui.status(`✓ idle since ${clock(now)}${t ? ` · turn ${t.n} took ${fmtMs(now - t.startedAt)}` : ''}`)
    if (t && t.endedAt === undefined && (await hasNoSurface($))) await notice($, `✓ turn ${t.n} · ${entryLine({ ...t, endedAt: now, reason: e.reason }, 140)}`)
    return answered
  })

  on('ui.render', { component: 'Pane', requestId: ACTIVITY }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [t, runs, ledger, v, now] = await Promise.all([readTurn($), read($, running), read($, done), read($, activityView), $.clock.now()])
    await read($, tick)
    const cols = Math.max(24, e.props.bodyColumns)
    const working = t !== null && t.endedAt === undefined
    const head = working
      ? `${fmtMs(now - t.startedAt)} · ${runs.length} running · ${t.tools.length} done`
      : t && t.endedAt !== undefined
        ? `idle since ${clock(t.endedAt)} · turn ${t.n} took ${fmtMs(t.endedAt - t.startedAt)}`
        : 'idle · nothing has run yet'
    const set = (patch: Partial<ActivityView>) => update($, activityView, cur => ({ ...cur, ...patch }))
    const recent = (t?.tools ?? []).slice(-8).reverse()

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Button key="collapse" plain onPress={() => set({ collapsed: !v.collapsed })}>
            {v.collapsed ? '▸' : '▾'}
          </Button>
          <Text color={working ? 'warning' : 'success'} weight="semibold">
            {working ? '⟳ ' : '✓ '}
            {cut(head, cols - 4)}
          </Text>
        </Box>
        {!v.collapsed && (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Button key="tab-now" plain dimColor={v.tab !== 'now'} onPress={() => set({ tab: 'now' })}>
                now
              </Button>
              <Button key="tab-done" plain dimColor={v.tab !== 'done'} onPress={() => set({ tab: 'done' })}>
                {`done ${ledger.length}`}
              </Button>
              <Button key="open-branches" plain dimColor onPress={() => openBranches($)}>
                branches
              </Button>
              <Button key="open-files" plain dimColor onPress={() => openFiles($)}>
                files
              </Button>
            </Box>
            {v.tab === 'now' && (
              <Box flexDirection="column">
                {working && runs.length === 0 && <Text dimColor>thinking…</Text>}
                {runs.map(r => (
                  <Text>
                    <Text color="warning">⟳ </Text>
                    {r.agentId ? '↳ ' : ''}
                    {cut(r.label, cols - 12)}
                    <Text dimColor>{` ${fmtMs(now - r.startedAt)}`}</Text>
                  </Text>
                ))}
                {recent.map(d => (
                  <Text dimColor>
                    <Text color={d.isError ? 'error' : 'success'}>{d.isError ? '✗ ' : '✓ '}</Text>
                    {d.agentId ? '↳ ' : ''}
                    {cut(d.label, cols - 12)}
                    {` ${fmtMs(d.ms)}`}
                  </Text>
                ))}
                {t && (t.files.length > 0 || t.commits.length > 0 || t.pushes > 0) && (
                  <Text dimColor>
                    {cut(
                      [
                        t.files.length ? `✎ ${t.files.length} file${t.files.length > 1 ? 's' : ''}` : '',
                        t.commits.length ? `⎇ ${t.commits.length} commit${t.commits.length > 1 ? 's' : ''}` : '',
                        t.pushes ? `↑ ${t.pushes} push${t.pushes > 1 ? 'es' : ''}` : '',
                      ]
                        .filter(Boolean)
                        .join(' · '),
                      cols - 2,
                    )}
                  </Text>
                )}
              </Box>
            )}
            {v.tab === 'done' && (
              <Box flexDirection="column">
                {ledger.length === 0 && <Text dimColor>No finished turns yet.</Text>}
                {ledger
                  .slice(-12)
                  .reverse()
                  .map(x => (
                    <Box flexDirection="column">
                      <Button key={`turn-${x.id}`} plain onPress={() => set({ open: v.open === x.id ? null : x.id })}>
                        {`${v.open === x.id ? '▾' : '▸'} ${entryLine(x, cols - 2)}`}
                      </Button>
                      {v.open === x.id &&
                        x.tools.slice(-12).map(d => (
                          <Text dimColor>{`   ${d.isError ? '✗' : '✓'} ${cut(d.label, cols - 14)} ${fmtMs(d.ms)}`}</Text>
                        ))}
                      {v.open === x.id && x.files.map(f => <Text>{`   ✎ ${cut(short(f), cols - 6)}`}</Text>)}
                      {v.open === x.id && x.commits.map(c => <Text>{`   ⎇ ${cut(c, cols - 6)}`}</Text>)}
                    </Box>
                  ))}
              </Box>
            )}
          </Box>
        )}
      </Box>
    )
  })

  // Where no pane is drawn (a narrow terminal, a surface without panes) the
  // same header rides above the prompt while a turn runs, and nothing when idle.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [t, runs] = await Promise.all([readTurn($), read($, running)])
    if (!t || t.endedAt !== undefined) return next(e)
    const placed = (await $.ui.panes()).some(p => p.id === ACTIVITY && p.isPlaced)
    if (placed) return next(e)
    await read($, tick)
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)
    const last = runs[runs.length - 1]
    return (
      <Box flexDirection="row">
        <Text color="warning">{`⟳ ${fmtMs(now - t.startedAt)} · ${runs.length} running`}</Text>
        <Text dimColor>{last ? ` · ${cut(last.label, 70)}` : ' · thinking…'}</Text>
      </Box>
    )
  })
}
