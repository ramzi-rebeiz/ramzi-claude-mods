import { expect, mock, test } from 'claude-code/testing'

import { graphSvg, verdictOf } from '../hooks/branches'
import { commitSubject, gitKindsOf, repoLabel, repoOf, short } from '../hooks/shared'
import { parsePorcelain } from '../hooks/workspace'

const PANE_PROPS = { title: 'Activity', isFocused: false, bodyColumns: 60, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 20 }, view: {} }

test('the Activity pane shows a running tool, then counts the turn as done', async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  mock.store(on)
  // The kit stands in for the engine beneath the plugin: each event the pane raises is answered here.
  // The call stays in flight until the test releases it.
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  let started: () => void = () => {}
  const begun = new Promise<void>(resolve => {
    started = resolve
  })
  on('tool.call', { tool: 'Bash' }, async () => {
    started()
    await held
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'answered' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('session.surfaces', () => ({ value: [] }))
  const session = mock.session(on)

  await $.turn.start({ text: 'commit the fix', turnId: 't1' })
  const call = $.tool.call({ tool: 'Bash', tool_use_id: 'u1', command: 'git commit -m "Fix the gateway"', description: 'commit the gateway fix' })
  await begun
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'ramzi-panes', surface, component: 'Pane', requestId: 'ramzi-activity', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /1 running/ }), `${surface}: header counts the running call; drawn: ${JSON.stringify(await ui.drawn()).slice(0, 600)}`).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /commit the gateway fix/ }), `${surface}: the call shows by its description`).toBeDefined()
    await ui.press({ key: 'collapse' })
    expect(await ui.find({ type: 'Text', text: /commit the gateway fix/ }), `${surface}: collapsed, the body is gone`).toBeUndefined()
    await ui.press({ key: 'collapse' })
    await ui.unmount()
  }
  clock.advance(5_000)
  release()
  await call
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'Committed.', durationMs: 5_000, isAborted: false })

  const ui = await $.ui.mount({ plugin: 'ramzi-panes', surface: 'desktop', component: 'Pane', requestId: 'ramzi-activity', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /idle since/ })).toBeDefined()
  await ui.press({ key: 'tab-done' })
  const row = await ui.find({ type: 'Button', text: /1 tools.*1 commit/ })
  expect(row, 'the ledger lists the turn with its commit').toBeDefined()
  await ui.press({ key: row!.key! })
  expect(await ui.find({ type: 'Text', text: /Fix the gateway/ }), 'the open entry names the commit').toBeDefined()
  await ui.unmount()

  const done = await $.command.run({ command: 'done', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(done.text).toMatch(/1 tools · 1 commit · commit the fix/)

  // With no surface attached (a Remote Control session) the summary goes to the transcript as a notice row.
  const notes = session.appended().filter(r => r.door === 'note')
  expect(notes, 'one notice row for the finished turn').toHaveLength(1)
  expect(JSON.stringify(notes[0]?.message)).toMatch(/✓ turn 1 .*1 tools · 1 commit/)
})

test('verdicts follow the counts against origin and the upstream', () => {
  expect(verdictOf({ ahead: 3, behind: 0, unpushed: 0, remoteAhead: 0 }, false)).toBe('ff')
  expect(verdictOf({ ahead: 3, behind: 2, unpushed: 0, remoteAhead: 0 }, false)).toBe('behind')
  expect(verdictOf({ ahead: 0, behind: 5, unpushed: null, remoteAhead: 0 }, false)).toBe('merged')
  expect(verdictOf({ ahead: 4, behind: 0, unpushed: 1, remoteAhead: 1 }, false)).toBe('diverged')
  expect(verdictOf({ ahead: 0, behind: 0, unpushed: 0, remoteAhead: 0 }, true)).toBe('default')
})

test('the graph names every branch and colours its verdict', () => {
  const svg = graphSvg(
    {
      root: '/home/r/docker-containers',
      label: 'docker-containers',
      defaultRef: 'origin/master',
      fetchedAt: null,
      branches: [
        { name: 'master', upstream: 'origin/master', isCurrent: false, ahead: 0, behind: 0, unpushed: 0, remoteAhead: 0, verdict: 'default' },
        { name: 'dc-ramzi-34', upstream: 'origin/dc-ramzi-34', isCurrent: true, ahead: 2, behind: 0, unpushed: 0, remoteAhead: 0, verdict: 'ff' },
        { name: 'dc-ramzi-33', upstream: 'origin/dc-ramzi-33', isCurrent: false, ahead: 1, behind: 4, unpushed: 0, remoteAhead: 0, verdict: 'behind' },
      ],
    },
    480,
  )
  expect(svg.startsWith('<svg')).toBe(true)
  expect(svg).toMatch(/dc-ramzi-34/)
  expect(svg).toMatch(/#3fb950/)
  expect(svg).toMatch(/#d29922/)
  expect(svg).not.toMatch(/<script/)
})

test('helpers read git commands, porcelain lines and paths', () => {
  expect([...gitKindsOf('git add x && git commit -m "a b" && git push origin dc-ramzi-1')].sort()).toEqual(['commit', 'push'])
  expect([...gitKindsOf('git log --oneline | head')]).toEqual([])
  expect(commitSubject("git commit -m 'Add the pane' -m 'body'")).toBe('Add the pane')
  expect(parsePorcelain(' M app/main.py')).toEqual({ code: ' M', path: 'app/main.py' })
  expect(parsePorcelain('R  old.py -> new.py')).toEqual({ code: 'R ', path: 'new.py' })
  expect(parsePorcelain('?? "with space.txt"')).toEqual({ code: '??', path: 'with space.txt' })
  expect(repoLabel('/home/r/console/c4/src')).toBe('c4/src')
  expect(repoLabel('/home/r/worktrees/dc-ramzi-34')).toBe('worktrees/dc-ramzi-34')
  expect(repoLabel('/home/r/docker-containers')).toBe('docker-containers')
  expect(repoOf('/home/r/docker-containers/a/b.py', ['/home/r', '/home/r/docker-containers'])).toBe('/home/r/docker-containers')
  expect(short('/home/ramzi_rebeiz/x/y')).toBe('~/x/y')
})
