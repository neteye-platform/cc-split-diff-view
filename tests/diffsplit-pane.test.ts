import type { On, UiPane } from 'claude-code'
import { expect, test } from 'claude-code/testing'

// The test runner has it; the types of the testing module do not declare it.
declare function setTimeout(fn: (value: unknown) => void, ms: number): unknown

const PANE = {
  plugin: 'cc-split-diff-view',
  component: 'Pane',
  requestId: 'diffsplit',
  surface: 'terminal',
  props: {
    title: 'Split Diff',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const RUN = {
  command: 'diffsplit',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 120 },
} as const

/** A new file of `lines` added lines, as `git diff` prints it. */
const added = (lines: number) =>
  [
    'diff --git a/f.txt b/f.txt',
    '--- /dev/null',
    '+++ b/f.txt',
    `@@ -0,0 +1,${lines} @@`,
    ...Array.from({ length: lines }, (_, i) => `+line number ${i} with some text in it`),
    '',
  ].join('\n')

/** The engine below the mod: an in-memory state, and git answering for `files` files of `lines` lines. */
function engine(on: On, files: number, lines: number) {
  // What the tests change and read: the tree git answers for, and how often the pane's list was stored.
  const tree = { files, lines, loads: 0 }
  const store = new Map<string, { value: unknown; version: number }>()
  on('state.get', (_, e) => ({ value: store.get(e.key) ?? { value: undefined, version: 0 } }))
  on('state.set', (_, e) => {
    const version = (store.get(e.key)?.version ?? 0) + 1
    store.set(e.key, { value: e.value, version })
    if (e.key === 'snapshot') tree.loads++
    return { value: { isSet: true, version } }
  })
  on('command.register', () => ({ value: { command: 'diffsplit' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', (_, e) => {
    const out = (stdout: string) => ({
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    const git = e.argv.join(' ')
    const names = Array.from({ length: tree.files }, (_, i) => `f${i}.txt`)
    if (git.includes('--name-status')) return out(names.map(name => `A\0${name}\0`).join(''))
    if (git.includes('--numstat')) return out(names.map(name => `${tree.lines}\t0\t${name}\0`).join(''))
    if (git.includes('rev-parse')) return out('true\n')
    if (git.includes('ls-files')) return out('')
    // The diff of the whole tree, as the pane reads it to tell if anything changed.
    if (!git.includes(' -- ')) return out(names.map(() => added(tree.lines)).join(''))
    return out(added(tree.lines))
  })
  return tree
}

/** Lets the work a hook started behind its answer run: a refresh is not awaited by the tool. */
async function settle() {
  await new Promise(resolve => setTimeout(resolve, 50))
}

test('the pane draws every file open, with its counts', async ($, on) => {
  engine(on, 2, 3)
  await $.command.run(RUN)

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /2 files/ }))?.text).toContain('2 files')
  expect((await ui.findAll({ type: 'Text', text: /^\+3$/ })).length).toBeGreaterThan(0)
  await ui.unmount()
})

test('the list at the top has a row per file, and a click on it goes through', async ($, on) => {
  engine(on, 3, 2)
  await $.command.run(RUN)

  const ui = await $.ui.mount(PANE)
  // One row in the list and one above its diff, per file.
  for (const name of ['f0.txt', 'f1.txt', 'f2.txt']) {
    expect(await ui.find({ type: 'Button', key: 'jump:' + name })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'file:' + name })).toBeDefined()
  }
  // The counts sit in the row, after the name.
  expect((await ui.findAll({ type: 'Text', text: /^\+2$/ })).length).toBeGreaterThanOrEqual(6)

  // The test engine has no scrolling to answer, so the target is not checked here: the
  // click must only leave the pane standing, and the key it aims at (`file:`) is drawn above.
  await ui.press({ key: 'jump:f1.txt' })
  expect(await ui.find({ type: 'Button', key: 'file:f1.txt' })).toBeDefined()
  await ui.unmount()
})

test('each file name sits between two lines the width of the pane', async ($, on) => {
  engine(on, 2, 2)
  await $.command.run(RUN)

  const ui = await $.ui.mount(PANE)
  const rules = await ui.findAll({ type: 'Text', text: /^─+$/ })
  expect(rules.map(rule => rule.text)).toEqual(Array(4).fill('─'.repeat(100)))
  await ui.unmount()
})

// The pane and the result of an Edit draw a diff through the same code: same summary, same rows.
test('a tool result and the pane draw the same diff', async ($, on) => {
  engine(on, 1, 2)
  await $.command.run(RUN)

  const result = await $.ui.mount({
    plugin: 'cc-split-diff-view',
    component: 'ToolResult',
    requestId: 'edit-1',
    surface: 'terminal',
    props: {
      tool_use_id: 'toolu_1',
      tool: 'Edit',
      isErrored: false,
      output: {
        filePath: '/tmp/f.txt',
        structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' keep', '-old', '+new'] }],
      },
    },
  })
  const pane = await $.ui.mount(PANE)

  // A hunk of the diff and the rule between the columns come out of both.
  for (const ui of [result, pane]) {
    expect(await ui.find({ type: 'Code', text: /^@@ -\d+,\d+ \+\d+,\d+ @@/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^│+$/ })).toBeDefined()
  }
  // Only the transcript has the summary line and its response marker: in the pane
  // the counts are on the file's row.
  expect(await result.find({ type: 'Text', text: /^Added $/ })).toBeDefined()
  expect(await result.find({ type: 'Text', text: /⎿/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^Added $/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /⎿/ })).toBeUndefined()
  await result.unmount()
  await pane.unmount()
})

/** The pane is open: what `$.ui.panes` answers. */
const OPEN = [{ id: 'diffsplit' }] as unknown as readonly UiPane[]

test('the open pane reloads by itself after a tool changes the tree', async ($, on) => {
  const tree = engine(on, 1, 2)
  on('clock.every', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: OPEN }))
  on('tool.call', () => ({ result: {} }))
  await $.command.run(RUN)
  expect(tree.loads).toBe(1)

  tree.files = 2
  await $.tool.call({ tool: 'Bash', command: 'touch f1.txt' })
  await settle()
  expect(tree.loads).toBe(2)

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Button', key: 'file:f1.txt' })).toBeDefined()
  await ui.unmount()
})

test('a tool that changes nothing leaves the pane as it is', async ($, on) => {
  const tree = engine(on, 1, 2)
  on('clock.every', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: OPEN }))
  on('tool.call', () => ({ result: {} }))
  await $.command.run(RUN)

  await $.tool.call({ tool: 'Bash', command: 'true' })
  await settle()
  expect(tree.loads).toBe(1)
})

test('a closed pane is not reloaded', async ($, on) => {
  const tree = engine(on, 1, 2)
  on('clock.every', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))
  await $.command.run(RUN)

  tree.files = 2
  await $.tool.call({ tool: 'Bash', command: 'touch f1.txt' })
  await settle()
  expect(tree.loads).toBe(1)
})

// The engine draws only the first 100000 characters of a tree: the chat is held to the
// same budget as the pane, or a result with long lines loses its end.
test('a tool result with long lines stops at the text budget and says so', async ($) => {
  const ui = await $.ui.mount({
    plugin: 'cc-split-diff-view',
    component: 'ToolResult',
    requestId: 'edit-2',
    surface: 'terminal',
    props: {
      tool_use_id: 'toolu_2',
      tool: 'Write',
      isErrored: false,
      output: {
        filePath: '/tmp/long.txt',
        structuredPatch: [
          { oldStart: 1, oldLines: 0, newStart: 1, newLines: 200, lines: Array.from({ length: 200 }, () => '+' + 'x'.repeat(600)) },
        ],
      },
    },
  })

  // 639 characters a row, 80000 characters of budget: 125 rows, 75 left out.
  expect((await ui.find({ type: 'Text', text: /more rows/ }))?.text).toBe('… 75 more rows')
  await ui.unmount()
})

// The engine refuses a tree of more than 20000 nodes, and the pane then draws nothing.
test('a pane with many long diffs still draws, and says what it left out', async ($, on) => {
  engine(on, 8, 300)
  await $.command.run(RUN)

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /more rows/ })).toBeDefined()
  await ui.unmount()
})
