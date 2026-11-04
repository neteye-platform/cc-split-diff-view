import type { Hunk } from '../types'
import { TEXT_BUDGET, drawFit, fitHunks } from './draw.js'
import type { Kit } from './draw.js'

/** Rows drawn for all the files of one Bash result. */
const MAX_ROWS = 200

/** Files drawn for one Bash result; the others are counted. */
const MAX_FILES = 20

/** Characters kept for what the engine draws around the diffs (the command's output). */
const MARGIN = 5_000

/** Where the built-in draws the "Created" and "Updated" rows: under the response marker. */
const INDENT = 5

/** A file a Bash command updated, with the hunks Claude Code found. */
export type UpdatedFile = { path: string; hunks: Hunk[] }

/** What is left of a Bash result once its updated files are taken out. */
export type BashSplit = {
  updated: UpdatedFile[]
  /** The result without those files; the built-in draws what is left. */
  rest: Record<string, unknown>
  /** Updated files past the limit of files, plus the ones Claude Code did not list. */
  hiddenFiles: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const hunksOf = (value: unknown): Hunk[] =>
  (Array.isArray(value) ? value : []).flatMap((hunk: unknown): Hunk[] => {
    if (!isRecord(hunk)) return []
    const { oldStart, newStart, lines } = hunk
    if (typeof oldStart !== 'number' || typeof newStart !== 'number' || !Array.isArray(lines)) return []
    return [{ oldStart, newStart, lines: lines.filter((line): line is string => typeof line === 'string') }]
  })

/**
 * Takes the files a Bash command updated out of its result. `bashEditDiff` is
 * Claude Code's per-file diff of the working tree before and after the command
 * (an internal field: it can change between releases).
 *
 * Created and deleted files stay in the result for the built-in to draw. So do
 * all the files when Claude Code could not tell what changed (`unavailable`,
 * `skipped`) or when another process may have changed them too (`shared`).
 *
 * @returns null when there is nothing to take out
 */
export function takeUpdatedFiles(output: unknown): BashSplit | null {
  if (!isRecord(output)) return null
  const diff = output.bashEditDiff
  if (!isRecord(diff) || !Array.isArray(diff.files)) return null
  if (diff.unavailable === true || diff.skipped === true || diff.shared === true) return null

  const updated: UpdatedFile[] = []
  const others: unknown[] = []
  for (const file of diff.files) {
    const hunks = isRecord(file) ? hunksOf(file.hunks) : []
    if (isRecord(file) && typeof file.filePath === 'string' && file.created !== true && file.deleted !== true && hunks.length > 0) {
      updated.push({ path: file.filePath, hunks })
    } else {
      others.push(file)
    }
  }
  if (updated.length === 0) return null

  const { bashEditDiff: _, ...rest } = output
  const moreFiles = typeof diff.moreFiles === 'number' ? diff.moreFiles : 0
  // Nothing left for the built-in to draw: leave the field out.
  if (others.length > 0 || moreFiles > 0) rest.bashEditDiff = { ...diff, files: others }

  return { updated: updated.slice(0, MAX_FILES), rest, hiddenFiles: Math.max(0, updated.length - MAX_FILES) + moreFiles }
}

/** True when the built-in has nothing of its own to draw for this result. */
export function isSilent(rest: Record<string, unknown>): boolean {
  const empty = (value: unknown) => typeof value !== 'string' || value.trim() === ''
  return (
    empty(rest.stdout) &&
    empty(rest.stderr) &&
    rest.bashEditDiff === undefined &&
    rest.interrupted !== true &&
    rest.backgroundTaskId === undefined &&
    rest.structuredContent === undefined
  )
}

/** The path as a person reads it: from the working directory when it is inside. */
export function displayPath(path: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '' || cwd === '/') return path
  return path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path
}

const count = (hunks: readonly Hunk[], mark: '+' | '-') =>
  hunks.reduce((total, hunk) => total + hunk.lines.filter(line => line.startsWith(mark)).length, 0)

/**
 * The updated files of a Bash result, one after the other: an "Updated path
 * (+3 -1)" row, then the diff in two columns. `columns` is the width of the
 * surface, when known; the diff sits under the indent.
 */
export function drawUpdatedFiles(kit: Kit, split: BashSplit, cwd: string | undefined, columns?: number) {
  const { Box, Text } = kit
  let rowsLeft = MAX_ROWS
  let charsLeft = Math.max(0, TEXT_BUDGET - MARGIN)

  const files = split.updated.map(file => {
    const fit = fitHunks(file.hunks, rowsLeft, charsLeft)
    rowsLeft -= fit.count
    charsLeft -= fit.chars
    return Box({
      flexDirection: 'column',
      children: [
        Box({
          flexDirection: 'row',
          marginLeft: INDENT,
          children: [
            Text({ children: ['Updated '] }),
            Text({ bold: true, children: [displayPath(file.path, cwd)] }),
            Text({ dimColor: true, children: [` (+${count(file.hunks, '+')} -${count(file.hunks, '-')})`] }),
          ],
        }),
        Box({ marginLeft: INDENT, flexDirection: 'column', children: [drawFit(kit, fit, file.path, columns === undefined ? undefined : columns - INDENT)] }),
      ],
    })
  })

  return {
    files,
    hidden:
      split.hiddenFiles > 0
        ? Text({
            dimColor: true,
            children: ['     … ' + split.hiddenFiles + (split.hiddenFiles === 1 ? ' more file' : ' more files')],
          })
        : null,
  }
}
