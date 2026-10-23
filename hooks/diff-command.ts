import { atom, read, update } from 'claude-code'
import type { ElementTable, Hook, On } from 'claude-code'

import { TEXT_BUDGET, drawFit, fitHunks } from './draw.js'
import type { Fit, Kit as DrawKit } from './draw.js'
import { parseChanges, parseHunks, parseUntracked } from './git-diff.js'
import type { Change, FileDiff, Snapshot } from '../types'

const COMMAND = 'diffsplit'
const PANE = 'diffsplit'

/** Rows drawn for one file before "… N more rows"; the pane scrolls. */
const MAX_ROWS = 500

/**
 * Rows drawn in all the files together. A row is about ten nodes of the tree
 * and the engine refuses a tree of more than 20000, which leaves the pane blank.
 */
const MAX_TOTAL_ROWS = 1200

/** Characters a file's row takes besides its path: the folding mark, the counts and the label. */
const FILE_ROW_CHARS = 30

/** Files whose diff is read, all at once on load; the rest are counted, not shown. */
const MAX_FILES = 100

/** How often the open pane looks for changes made outside the tools Claude runs. */
const POLL_MS = 3000

/** Tools that can change the working tree: the open pane reloads when one ends. */
const WRITING_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Bash'] as const

/** Git's name for an empty tree, the base of a repository with no commit yet. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

const GIT = ['git', '--no-pager', '-c', 'core.quotepath=off']
const DIFF = ['diff', '--no-color', '--no-ext-diff', '--no-renames']

/**
 * The same for the tracked files. Git names them from the root of the
 * repository, but the untracked ones (`ls-files --others`) from the working
 * directory; `--relative` names both from the working directory, so a path
 * from one list works as a pathspec of the diff in the other. It also keeps the
 * list to the working directory, as `ls-files` does.
 */
const TRACKED = [...DIFF, '--relative']

// Change the tag when the fields of a value change: it declines what an
// earlier version stored, which outlives a reload.
const snapshot = atom({ plugin: 'cc-split-diff-view', key: 'snapshot' } as const, null, { shape: 'snapshot-2' })
const folded = atom({ plugin: 'cc-split-diff-view', key: 'folded' } as const, [], { shape: 'folded-1' })

/** The engine interface a hook receives as `$`. */
type Engine = Parameters<Hook<'command.run'>>[0]

type Kit = DrawKit & Pick<ElementTable<'terminal'>, 'Button'>

// The module's own, so a reload of the code starts them over: what the pane
// drew last (see `fingerprint`), the timer that watches the tree, and whether
// a refresh is under way.
let seen = ''
let timer: { cancel: () => void } | undefined
let isRefreshing = false

/**
 * Registers `/diffsplit`: a pane that lists the uncommitted changes of the
 * working directory, each file open under its name as a split diff.
 *
 * @param on the engine's registrar
 */
export function registerDiffSplit(on: On) {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show the uncommitted changes in a split diff pane',
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const loaded = await load($, { isReload: false })
    seen = await fingerprint($).catch(() => '')
    await $.ui.open({ id: PANE, title: 'Split Diff', focus: true, closeOnEscape: true, rows: 30, columns: 120 })

    // While the pane is open, look at the tree now and then: it ends itself when the pane closes.
    timer?.cancel()
    timer = $.clock.every(POLL_MS, () => void refresh($))
    if (loaded.kind === 'error') return { text: loaded.message }
    const n = loaded.files.length + loaded.hiddenFiles
    return { text: n === 0 ? 'No uncommitted changes.' : `Split diff opened: ${n} changed ${n === 1 ? 'file' : 'files'}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const kit: Kit = $.ui.resolve(e)
    const current = await read($, snapshot)
    const closed = await read($, folded)

    if (current === null) return kit.Text({ dimColor: true, children: ['Run /diffsplit to load the changes.'] })
    if (current.kind === 'error') return kit.Text({ color: 'error', children: [current.message] })

    return drawFiles($, kit, current.files, current.hiddenFiles, closed, e.props.bodyColumns)
  })

  // A tool that may have written files: the open pane shows it at once.
  on('tool.call', { tool: WRITING_TOOLS }, async ($, e, next) => {
    const ran = await next(e)
    void refresh($)
    return ran
  })
}

/**
 * Asks git for the changes against HEAD, plus the untracked files, and keeps
 * them. A reload from the pane itself keeps the files the person folded.
 */
async function load($: Engine, { isReload }: { isReload: boolean }): Promise<Snapshot> {
  const result = await ask($)
  await update($, snapshot, () => result)
  if (!isReload) await update($, folded, () => [])
  return result
}

/** Git's base for the diff: HEAD, or the empty tree in a repository with no commit yet. */
async function baseOf($: Engine) {
  const head = await $.process.run([...GIT, 'rev-parse', '--verify', '--quiet', 'HEAD'])
  return head.exitCode === 0 ? 'HEAD' : EMPTY_TREE
}

/**
 * A stand-in for the state of the working tree: the diff of the tracked files,
 * and the names and content hashes of the untracked ones. Two equal strings
 * mean nothing changed, and the pane is not drawn again.
 */
async function fingerprint($: Engine): Promise<string> {
  const git = (args: string[], stdin?: string) => $.process.run([...GIT, ...args], stdin === undefined ? undefined : { stdin })
  const [diff, others] = await Promise.all([git([...TRACKED, await baseOf($)]), git(['ls-files', '--others', '--exclude-standard', '-z'])])
  const paths = others.stdout.split('\0').filter(path => path !== '')
  const hashes = paths.length === 0 ? '' : (await git(['hash-object', '--stdin-paths'], paths.join('\n'))).stdout
  return [diff.stdout, others.stdout, hashes].join('\u0001')
}

/** Reloads the pane whether or not the tree changed: the person asked. */
async function reloadNow($: Engine) {
  await load($, { isReload: true })
  seen = await fingerprint($).catch(() => seen)
}

/**
 * Reloads the pane if it is open and the working tree is not what it drew.
 * Never throws and never runs twice at once; a failure is tried again on the
 * next tick.
 */
async function refresh($: Engine) {
  if (isRefreshing) return
  isRefreshing = true
  try {
    if (!(await $.ui.panes()).some(pane => pane.id === PANE)) {
      timer?.cancel()
      timer = undefined
      return
    }
    const now = await fingerprint($)
    if (now === seen) return
    await load($, { isReload: true })
    seen = now
  } catch {
    // The next tick tries again.
  } finally {
    isRefreshing = false
  }
}

async function ask($: Engine): Promise<Snapshot> {
  const git = (args: string[]) => $.process.run([...GIT, ...args])

  const inside = await git(['rev-parse', '--is-inside-work-tree']).catch(() => null)
  if (inside === null || inside.exitCode !== 0) return { kind: 'error', message: 'Not inside a git repository.' }

  const base = await baseOf($)
  const [nameStatus, numstat, others] = await Promise.all([
    git([...TRACKED, '--name-status', '-z', base]),
    git([...TRACKED, '--numstat', '-z', base]),
    git(['ls-files', '--others', '--exclude-standard', '-z']),
  ])
  if (nameStatus.exitCode !== 0) return { kind: 'error', message: nameStatus.stderr.trim() || 'git diff failed.' }

  const all = [...parseChanges(nameStatus.stdout, numstat.stdout), ...parseUntracked(others.stdout)]
  const files = await Promise.all(all.slice(0, MAX_FILES).map(change => diffOf($, change, base)))
  return { kind: 'changes', files, hiddenFiles: Math.max(0, all.length - MAX_FILES) }
}

/** One file with its hunks. An untracked file gets its counts from them. */
async function diffOf($: Engine, change: Change, base: string): Promise<FileDiff> {
  if (change.isBinary) return { ...change, hunks: [] }

  const git = (args: string[]) => $.process.run([...GIT, ...args])
  // `--no-index` exits 1 when the files differ, which an untracked file always does.
  const shown =
    change.status === 'untracked'
      ? await git([...DIFF, '--no-index', '--', '/dev/null', change.path])
      : await git([...TRACKED, base, '--', change.path])
  const hunks = parseHunks(shown.stdout)
  if (change.status !== 'untracked') return { ...change, hunks }

  const added = hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.startsWith('+')).length, 0)
  return { ...change, added, hunks }
}

function drawFiles($: Engine, kit: Kit, files: FileDiff[], hidden: number, closed: string[], columns: number) {
  const { Box, Text, Button } = kit
  const added = files.reduce((sum, file) => sum + file.added, 0)
  const removed = files.reduce((sum, file) => sum + file.removed, 0)
  const count = files.length + hidden

  // The list, and the name and two rules of each file, come off the character budget first.
  const frame = files.reduce((sum, file) => sum + 2 * (file.path.length + FILE_ROW_CHARS) + 2 * columns, 0)

  // Each open file draws what is left of the row and character budgets.
  let rowsLeft = MAX_TOTAL_ROWS
  let charsLeft = Math.max(0, TEXT_BUDGET - frame)
  const drawn = files.map(file => {
    const isFolded = closed.includes(file.path)
    const isShown = !isFolded && !file.isBinary && file.hunks.length > 0
    const fit = isShown ? fitHunks(file.hunks, Math.min(MAX_ROWS, rowsLeft), charsLeft) : null
    rowsLeft -= fit?.count ?? 0
    charsLeft -= fit?.chars ?? 0
    return drawFile($, kit, file, isFolded, fit, columns)
  })

  return Box({
    flexDirection: 'column',
    children: [
      Box({
        flexDirection: 'row',
        children: [
          Text({ bold: true, children: ['Uncommitted changes'] }),
          Text({ dimColor: true, children: [` · ${count} ${count === 1 ? 'file' : 'files'} · `] }),
          Text({ color: 'success', children: ['+' + added] }),
          Text({ children: [' '] }),
          Text({ color: 'error', children: ['-' + removed] }),
        ],
      }),
      Text({ dimColor: true, children: ['↑↓ move · Enter jump to a file, or fold it · r refresh · Esc close'] }),
      count === 0 ? Text({ dimColor: true, children: ['Working tree clean.'] }) : null,
      // The list: a click takes the pane to the file.
      ...files.map(file =>
        fileRow(kit, file, {
          key: 'jump:' + file.path,
          label: file.path,
          // A pane that is not drawn cannot scroll; that is no error.
          onPress: () => void $.ui.scroll({ to: { key: 'file:' + file.path }, in: PANE, block: 'start' }).catch(() => undefined),
        }),
      ),
      ...drawn,
      hidden > 0 ? Text({ dimColor: true, children: [`… ${hidden} more files not shown`] }) : null,
      Box({
        flexDirection: 'row',
        marginTop: 1,
        children: [Button({ key: 'refresh', hotkey: 'r', onPress: () => void reloadNow($), children: ['Refresh'] })],
      }),
    ],
  })
}

function drawFile($: Engine, kit: Kit, file: FileDiff, isFolded: boolean, fit: Fit | null, columns: number) {
  const { Box, Text } = kit
  const toggle = () =>
    void update($, folded, list => (list.includes(file.path) ? list.filter(path => path !== file.path) : [...list, file.path]))
  // The name sits between two lines, the whole width of the pane.
  const rule = () => Text({ dimColor: true, wrap: 'truncate-end', children: ['─'.repeat(columns)] })

  return Box({
    flexDirection: 'column',
    marginTop: 1,
    children: [
      rule(),
      fileRow(kit, file, { key: 'file:' + file.path, label: (isFolded ? '▸ ' : '▾ ') + file.path, onPress: toggle }),
      rule(),
      isFolded ? null : body(kit, file, fit),
    ],
  })
}

/** A file's row: its name is the button, and its counts sit at the end of the row. */
function fileRow({ Box, Text, Button }: Kit, file: FileDiff, { key, label, onPress }: { key: string; label: string; onPress: () => void }) {
  return Box({
    flexDirection: 'row',
    children: [
      Box({ flexGrow: 1, flexShrink: 1, children: [Button({ key, plain: true, onPress, children: [label] })] }),
      Box({ flexShrink: 0, flexDirection: 'row', children: counts(Text, file) }),
    ],
  })
}

function counts(Text: Kit['Text'], file: FileDiff) {
  const label = file.status === 'untracked' ? [Text({ dimColor: true, children: ['untracked '] })] : []
  if (file.isBinary) return [...label, Text({ dimColor: true, children: ['binary'] })]
  return [
    ...label,
    Text({ color: 'success', children: ['+' + file.added] }),
    Text({ children: [' '] }),
    Text({ color: 'error', children: ['-' + file.removed] }),
  ]
}

function body(kit: Kit, file: FileDiff, fit: Fit | null) {
  const { Text } = kit
  if (file.isBinary) return Text({ dimColor: true, children: ['Binary file.'] })
  if (fit === null) {
    const empty = file.status === 'deleted' ? 'Empty file deleted.' : 'No changes to show.'
    return Text({ dimColor: true, children: [empty] })
  }

  return drawFit(kit, fit, file.path)
}
