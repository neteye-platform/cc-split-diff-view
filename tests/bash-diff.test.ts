import { expect, test } from 'claude-code/testing'

import { displayPath, isSilent, takeUpdatedFiles } from '../hooks/bash-diff.js'

const hunk = { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' keep', '-old', '+new'] }

const result = (bashEditDiff: unknown, extra: Record<string, unknown> = {}) => ({
  stdout: 'done',
  stderr: '',
  interrupted: false,
  bashEditDiff,
  ...extra,
})

type Ctx = Parameters<Parameters<typeof test>[1]>[0]
type Register = Parameters<Parameters<typeof test>[1]>[1]

/** Mounts the result of a Bash call; a stand-in for the engine answers where the mod hands the drawing back. */
const mount = ($: Ctx, on: Register, output: unknown) => {
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: ['engine drawing'] }))
  return $.ui.mount({
    plugin: 'cc-split-diff-view',
    component: 'ToolResult',
    requestId: 'bash-1',
    surface: 'terminal',
    props: { tool_use_id: 'toolu_b', tool: 'Bash', isErrored: false, output },
  })
}

test('takes the updated files out and keeps the created ones for the built-in', async () => {
  const split = takeUpdatedFiles(
    result({
      files: [
        { filePath: '/w/a.txt', hunks: [hunk] },
        { filePath: '/w/new.txt', hunks: [hunk], created: true },
        { filePath: '/w/gone.txt', hunks: [hunk], deleted: true },
      ],
      moreFiles: 0,
    }),
  )
  expect(split?.updated.map(file => file.path)).toEqual(['/w/a.txt'])
  const left = (split?.rest.bashEditDiff as { files: { filePath: string }[] }).files
  expect(left.map(file => file.filePath)).toEqual(['/w/new.txt', '/w/gone.txt'])
  expect(split?.rest.stdout).toBe('done')
})

test('leaves the field out when every file was an update', async () => {
  const split = takeUpdatedFiles(result({ files: [{ filePath: '/w/a.txt', hunks: [hunk] }], moreFiles: 0 }))
  expect(split).not.toBeNull()
  expect('bashEditDiff' in (split?.rest ?? {})).toBe(false)
})

test('counts the files Claude Code did not list', async () => {
  const split = takeUpdatedFiles(result({ files: [{ filePath: '/w/a.txt', hunks: [hunk] }], moreFiles: 3 }))
  expect(split?.hiddenFiles).toBe(3)
  expect(split?.rest.bashEditDiff).toEqual({ files: [], moreFiles: 3 })
})

test('does nothing without an update, or when Claude Code could not tell what changed', async () => {
  expect(takeUpdatedFiles(undefined)).toBeNull()
  expect(takeUpdatedFiles({ stdout: '' })).toBeNull()
  expect(takeUpdatedFiles(result({ files: [{ filePath: '/w/n.txt', hunks: [hunk], created: true }], moreFiles: 0 }))).toBeNull()
  for (const flag of ['unavailable', 'skipped', 'shared']) {
    const files = [{ filePath: '/w/a.txt', hunks: [hunk] }]
    expect(takeUpdatedFiles(result({ files, moreFiles: 0, [flag]: true }))).toBeNull()
  }
})

test('is silent only when the built-in has nothing to draw', async () => {
  expect(isSilent({ stdout: '', stderr: '  ', interrupted: false })).toBe(true)
  expect(isSilent({ stdout: 'x', stderr: '', interrupted: false })).toBe(false)
  expect(isSilent({ stdout: '', stderr: '', interrupted: true })).toBe(false)
  expect(isSilent({ stdout: '', stderr: '', bashEditDiff: { files: [] } })).toBe(false)
})

test('shows a path from the working directory when it is inside', async () => {
  expect(displayPath('/w/src/a.ts', '/w')).toBe('src/a.ts')
  expect(displayPath('/other/a.ts', '/w')).toBe('/other/a.ts')
  expect(displayPath('/wx/a.ts', '/w')).toBe('/wx/a.ts')
  expect(displayPath('/w/a.ts', undefined)).toBe('/w/a.ts')
})

test('a Bash result with an update draws the file row and the split diff', async ($, on) => {
  const ui = await mount($, on, result({ files: [{ filePath: '/w/a.txt', hunks: [hunk] }], moreFiles: 0 }))
  expect(await ui.find({ type: 'Text', text: /^Updated $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ \(\+1 -1\)$/ })).toBeDefined()
  expect(await ui.find({ type: 'Code', text: /^@@ -\d+,\d+ \+\d+,\d+ @@/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^│+$/ })).toBeDefined()
  await ui.unmount()
})

test('a Bash result with only a created file is left to the built-in', async ($, on) => {
  const ui = await mount($, on, result({ files: [{ filePath: '/w/new.txt', hunks: [hunk], created: true }], moreFiles: 0 }))
  expect(await ui.find({ type: 'Text', text: /^Updated $/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^│+$/ })).toBeUndefined()
  await ui.unmount()
})

/** An update of 25 changed lines of 500 characters: about 51000 characters of diff, under the 75000 of budget. */
const bigUpdate = () => ({
  files: [
    {
      filePath: '/w/a.txt',
      hunks: Array.from({ length: 25 }, (_, i) => ({
        oldStart: i * 10 + 1,
        oldLines: 1,
        newStart: i * 10 + 1,
        newLines: 1,
        lines: ['-' + 'a'.repeat(500), '+' + 'b'.repeat(500)],
      })),
    },
  ],
  moreFiles: 0,
})

test('a short command output leaves the whole diff its text budget', async ($, on) => {
  const ui = await mount($, on, result(bigUpdate(), { stdout: 'done' }))
  expect(await ui.find({ type: 'Text', text: /more rows/ })).toBeUndefined()
  await ui.unmount()
})

test('a long command output comes off the text budget of the diffs', async ($, on) => {
  const ui = await mount($, on, result(bigUpdate(), { stdout: 'x'.repeat(40_000) }))
  expect(await ui.find({ type: 'Text', text: /more rows/ })).toBeDefined()
  await ui.unmount()
})
