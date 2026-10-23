import type { ElementTable } from 'claude-code'

import type { Hunk } from '../types'
import type { Cell, SplitDiff, SplitRow } from './split-rows.js'

export type Kit = Pick<ElementTable<'terminal'>, 'Box' | 'Text' | 'Code'>

/**
 * Where a split diff sits. The rows are the same everywhere; only what
 * surrounds them differs.
 */
const LAYOUTS = {
  /** Under a tool call in the transcript: the summary line with the built-in's response marker, and a frame. */
  'tool-result': { lead: '  ⎿  ', indent: 5, isFramed: true },
  /** In the pane: no summary (the file's row has the counts), no frame, the rule between the columns alone. */
  pane: { lead: null, indent: 0, isFramed: false },
} as const

export type DiffLayout = keyof typeof LAYOUTS

/**
 * Characters of diff text drawn in one tree. The engine draws only the first
 * 100000 and cuts the rest, the "… more rows" with it; the margin is for the
 * text around the diff.
 */
export const TEXT_BUDGET = 80_000

/** Lines of the rule between the columns; a row that wraps past it shows a gap in the rule. */
const RULE_LENGTH = 16

/** Characters of a one-line hunk header (`@@ -12,1 +12,1 @@` and the mark). */
const HEADER_LENGTH = 22

/**
 * The characters of text a row puts in the tree. The engine draws only the
 * first 100000 of a tree, so a long diff has to be counted before it is drawn.
 */
function rowChars(row: SplitRow) {
  if (row.kind === 'gap') return 60
  const text = (cell: Cell | null) => (cell === null ? 1 : HEADER_LENGTH + cell.text.length)
  // A changed pair is drawn as one hunk in each column.
  if (row.changed && row.left !== null && row.right !== null) {
    return 2 * (HEADER_LENGTH + row.left.text.length + row.right.text.length) + RULE_LENGTH
  }
  return text(row.left) + text(row.right) + RULE_LENGTH
}

/**
 * How many of the first rows of a diff fit in `maxRows` rows and `maxChars`
 * characters of text, and the characters those rows take.
 */
export function rowsWithin(diff: SplitDiff, maxRows: number, maxChars: number) {
  let count = 0
  let chars = 0
  for (const row of diff.rows.slice(0, maxRows)) {
    const next = chars + rowChars(row)
    if (next > maxChars) break
    chars = next
    count++
  }
  return { count, chars }
}

export type DiffOptions = {
  /** The file's path, for the language of the highlighting. */
  path: string | undefined
  /** Rows drawn before "… N more rows". */
  maxRows: number
  layout: DiffLayout
}

/**
 * A split diff: the removed lines in the left column and the added ones in the
 * right, with line numbers, under a "Added 3 lines, removed 1 line" summary
 * where the layout has one. Every place that draws a diff goes through here.
 */
export function drawDiff(kit: Kit, diff: SplitDiff, { path, maxRows, layout }: DiffOptions) {
  const { Box, Text } = kit
  const { lead, indent, isFramed } = LAYOUTS[layout]

  return Box({
    flexDirection: 'column',
    children: [
      lead === null
        ? null
        : Box({
            flexDirection: 'row',
            children: [Text({ dimColor: true, children: [lead] }), ...summary(Text, diff.added, diff.removed)],
          }),
      Box({
        flexDirection: 'column',
        marginLeft: indent,
        ...(isFramed ? { borderStyle: 'round', borderDimColor: true } : {}),
        children: drawRows(kit, diff, path, maxRows),
      }),
    ],
  })
}

/**
 * A diff as git prints it, for what has no split form (a file with a final
 * newline on one side only): the engine's own diff drawing, one hunk after
 * the other.
 */
export function drawUnifiedHunks({ Code }: Kit, hunks: readonly Hunk[], path: string | undefined) {
  const source = hunks
    .map(hunk => `@@ -${hunk.oldStart} +${hunk.newStart} @@\n` + hunk.lines.join('\n'))
    .join('\n')
  return Code({ source, format: 'diff', wrap: 'wrap', ...(path === undefined ? {} : { path }) })
}

/**
 * The rows of a split diff, ready to sit in a column, with "… N more rows"
 * after the first `maxRows`.
 */
function drawRows(kit: Kit, diff: SplitDiff, path: string | undefined, maxRows: number) {
  const shown = diff.rows.slice(0, maxRows)
  const hidden = diff.rows.length - shown.length
  return [
    ...shown.map(row => drawRow(kit, row, path)),
    hidden > 0 ? kit.Text({ dimColor: true, children: ['… ' + hidden + ' more rows'] }) : null,
  ]
}

function drawRow(kit: Kit, row: SplitRow, path: string | undefined) {
  const { Box, Text } = kit
  if (row.kind === 'gap') {
    // The label sits in both columns, so a wide screen doesn't leave the right one blank.
    const label = () => Text({ dimColor: true, children: ['⋯ ' + row.hidden + ' unchanged lines'] })
    // A blank line above and below sets the label apart; an empty 1-wide Box takes the separator's place so the columns line up.
    const column = { width: '50%', flexShrink: 1, paddingY: 1 } as const
    return Box({
      flexDirection: 'row',
      children: [Box({ ...column, children: [label()] }), Box({ width: 1, flexShrink: 0 }), Box({ ...column, children: [label()] })],
    })
  }
  if (row.changed && row.left !== null && row.right !== null) {
    return drawPair(kit, row.left, row.right, path)
  }
  return Box({
    flexDirection: 'row',
    alignItems: 'stretch',
    children: [
      drawCell(kit, row.left, row.changed ? 'removed' : 'same', path),
      separator(kit),
      drawCell(kit, row.right, row.changed ? 'added' : 'same', path),
    ],
  })
}

function drawCell(
  { Box, Text, Code }: Kit,
  cell: Cell | null,
  kind: 'removed' | 'added' | 'same',
  path: string | undefined,
) {
  const column = { width: '50%', flexShrink: 1, flexDirection: 'row' } as const

  // Nothing on this side of the row: keep the column, draw nothing in it.
  if (cell === null) return Box({ ...column, children: [Text({ children: [' '] })] })

  // One-line hunk through the engine's diff renderer, so gutter, marker and
  // add/remove colors are exactly the built-in diff's.
  const n = cell.no
  const header =
    kind === 'removed' ? `@@ -${n},1 +${n},0 @@` : kind === 'added' ? `@@ -${n},0 +${n},1 @@` : `@@ -${n},1 +${n},1 @@`
  const sign = kind === 'removed' ? '-' : kind === 'added' ? '+' : ' '

  return Box({
    ...column,
    children: [
      Code({
        source: header + '\n' + sign + cell.text,
        format: 'diff',
        wrap: 'wrap',
        ...(path === undefined ? {} : { path }),
      }),
    ],
  })
}

/**
 * A removed line next to the line that replaced it. The engine draws the two as
 * one hunk, which is what makes it tint the words that changed; each column
 * then shows its own line of that hunk. Long lines are cut with an ellipsis, as
 * a column clipped to one row cannot wrap.
 */
function drawPair(kit: Kit, left: Cell, right: Cell, path: string | undefined) {
  const { Box, Code } = kit
  const hunk = () =>
    Code({
      source: `@@ -${left.no},1 +${right.no},1 @@\n-${left.text}\n+${right.text}`,
      format: 'diff',
      wrap: 'truncate-end',
      ...(path === undefined ? {} : { path }),
    })
  const column = { width: '50%', flexShrink: 1, height: 1, overflow: 'hidden' } as const
  return Box({
    flexDirection: 'row',
    children: [
      Box({ ...column, children: [hunk()] }),
      separator(kit),
      Box({
        ...column,
        children: [Box({ position: 'absolute', top: -1, left: 0, right: 0, children: [hunk()] })],
      }),
    ],
  })
}

/**
 * A dim vertical rule between the columns. It stretches to the row's height
 * (wrapped lines make rows taller), so it draws a tall line out of flow and
 * lets the clipped box cut it to the row.
 */
function separator({ Box, Text }: Kit) {
  return Box({
    width: 1,
    flexShrink: 0,
    overflow: 'hidden',
    children: [
      Box({
        position: 'absolute',
        top: 0,
        bottom: 0,
        width: 1,
        // One node: the glyphs wrap at the box's one column, a line each.
        children: [Text({ dimColor: true, children: ['│'.repeat(RULE_LENGTH)] })],
      }),
    ],
  })
}

/** "Added 3 lines, removed 1 line", the counts bold, as the built-in diff words it. */
function summary(Text: Kit['Text'], added: number, removed: number) {
  const noun = (n: number) => (n > 1 ? ' lines' : ' line')
  const parts: ReturnType<Kit['Text']>[] = []
  if (added > 0) {
    parts.push(Text({ children: ['Added '] }), Text({ bold: true, children: [String(added)] }))
    parts.push(Text({ children: [noun(added) + (removed > 0 ? ', ' : '')] }))
  }
  if (removed > 0) {
    parts.push(Text({ children: [added === 0 ? 'Removed ' : 'removed '] }))
    parts.push(Text({ bold: true, children: [String(removed)] }), Text({ children: [noun(removed)] }))
  }
  return parts
}
