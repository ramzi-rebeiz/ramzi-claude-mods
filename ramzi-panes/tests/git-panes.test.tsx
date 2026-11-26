import { expect, mock, test } from 'claude-code/testing'

const PANE = { isFocused: false, bodyColumns: 70, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }

/** A world of one repo at /h/app with master and one branch of Ramzi's, two commits ahead and one behind. */
function fakeHost(on: Parameters<Parameters<typeof test>[1]>[1]) {
  mock.clock(on, { now: 1_700_000_000_000 })
  mock.env(on, { HOME: '/h' })
  on('session.root', () => ({ value: '/h/app' }))
  on('fs.exists', ($, e) => ({ value: e.path === '/h/app/.git' }))
  on('fs.list', ($, e) => ({ value: e.path === '/h/app' ? [{ name: 'src', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] : e.path === '/h/app/src' ? [{ name: 'main.py', kind: 'file' as const, size: 10, mtimeMs: 0, isLink: false }] : [] }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 1_699_999_000_000 } }))
  on('fs.read', () => ({ value: 'print(1)\n' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.run', () => ({ text: '' }))
  on('process.run', ($, e) => {
    const args = e.argv.slice(2).join(' ')
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (args.startsWith('symbolic-ref')) return ok('origin/master\n')
    if (args.startsWith('rev-parse --git-common-dir')) return ok('.git\n')
    if (args.startsWith('rev-parse --abbrev-ref')) return ok('app-ramzi-1\n')
    if (args.startsWith('for-each-ref')) return ok('master\torigin/master\t \napp-ramzi-1\torigin/app-ramzi-1\t*\n')
    if (args.includes('--left-right')) return ok(args.endsWith('...master') ? '0\t0\n' : '1\t2\n')
    if (args.startsWith('rev-list --count')) return ok('0\n')
    if (args.startsWith('status --porcelain')) return ok(' M src/main.py\n')
    if (args.startsWith('diff')) return ok('--- a/src/main.py\n+++ b/src/main.py\n@@ -1 +1 @@\n-print(0)\n+print(1)\n')
    return ok('')
  })
}

test('the Branches pane draws a verdict line and, on a graphical surface, the graph', async ($, on) => {
  fakeHost(on)
  const opened = await $.command.run({ command: 'branches', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(opened.text).toMatch(/Branches pane/)
  for (const surface of ['desktop', 'terminal', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'ramzi-panes', surface, component: 'Pane', requestId: 'ramzi-branches', props: { ...PANE, title: 'Branches' } })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Button', text: /app/ }), `${surface}: the repo row`).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /app-ramzi-1.*\+2 −1.*sync owed/ }), `${surface}: the verdict line; drawn ${JSON.stringify(await ui.drawn()).slice(0, 500)}`).toBeDefined()
    await ui.press({ key: 'repo-/h/app' })
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Svg' }), 'the terminal has no Svg').toBeUndefined()
    } else {
      const svg = await ui.find({ type: 'Svg' })
      expect(svg, `${surface}: the graph`).toBeDefined()
      expect(String(svg?.props['source'])).toMatch(/app-ramzi-1/)
    }
    await ui.press({ key: 'repo-/h/app' })
    await ui.unmount()
  }
})

test('the Files pane lists the changed file, previews its diff and walks the tree', async ($, on) => {
  fakeHost(on)
  await $.command.run({ command: 'files', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  for (const surface of ['desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'ramzi-panes', surface, component: 'Pane', requestId: 'ramzi-files', props: { ...PANE, title: 'Files' } })
    await ui.press({ key: 'refresh' })
    const row = await ui.find({ type: 'Button', key: 'f-/h/app/src/main.py' })
    expect(row, `${surface}: the dirty file is listed; drawn ${JSON.stringify(await ui.drawn()).slice(0, 500)}`).toBeDefined()
    expect(row?.text).toMatch(/M\s+src\/main\.py/)
    await ui.press({ key: 'f-/h/app/src/main.py' })
    const code = await ui.find({ type: 'Code' })
    expect(code, `${surface}: the diff preview`).toBeDefined()
    expect(code?.props['format']).toBe('diff')
    await ui.press({ key: 'preview-close' })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    await ui.press({ key: 'mode-tree' })
    await ui.press({ key: 'repo-/h/app' })
    expect(await ui.find({ type: 'Button', key: 'd-/h/app/src' }), `${surface}: the tree shows src/`).toBeDefined()
    await ui.press({ key: 'd-/h/app/src' })
    expect(await ui.find({ type: 'Button', key: 'f-/h/app/src/main.py' }), `${surface}: the file under src/`).toBeDefined()
    await ui.press({ key: 'd-/h/app/src' })
    await ui.press({ key: 'repo-/h/app' })
    await ui.press({ key: 'mode-changed' })
    await ui.unmount()
  }
})
